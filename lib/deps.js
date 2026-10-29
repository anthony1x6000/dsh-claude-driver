// Dependency check and auto-install for the one thing npm/pnpm cannot always
// lay down with the plugin: the Claude Code CLI binary.
//
// Principles:
//   * LOOK FIRST. Anything already usable (configured path, SDK-bundled binary,
//     a previous private install, ~/.local/bin/claude, PATH) means no install.
//   * Install ONLY the missing piece, into a driver-owned prefix under
//     $DSH_HOME/storages/claude-driver/cli. Never global, never sudo, never
//     touching the user's own npm/pnpm state or the DSH profile.
//   * Install the exact version the SDK pins, for this platform only.
//   * One installer at a time (lock dir, stale-safe), bounded by a timeout, and a
//     failure is remembered so a broken network does not mean a retry on every turn.
//   * Never throw into the host: every outcome is a plain result object.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { locateClaude, privateCliPrefix } from './claude-executable.js'

const requireFromHere = createRequire(import.meta.url)

const DEFAULTS = {
  installTimeoutMs: 5 * 60_000,
  retryMs: 60 * 60_000, // after a failed install, do not retry for an hour (force overrides)
  lockStaleMs: 15 * 60_000,
  versionTimeoutMs: 20_000,
}

const exeName = () => (process.platform === 'win32' ? 'claude.exe' : 'claude')

/** Default process runner: never throws on a non-zero exit, always bounded. */
export function runProcess(cmd, args, { timeoutMs = 60_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, cwd, env: env ?? process.env, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error.code === 'ENOENT' || error.killed || error.signal)) {
        error.message = `${cmd} ${args[0] ?? ''}: ${error.message}`
        return reject(error)
      }
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
    child.stdin?.end()
  })
}

function isMusl() {
  if (process.platform !== 'linux') return false
  try {
    return !process.report?.getReport?.().header?.glibcVersionRuntime
  } catch {
    return false
  }
}

/** SDK platform package suffixes to try, best match first. */
export function platformPackages({ platform = process.platform, arch = process.arch, musl = isMusl() } = {}) {
  if (platform !== 'linux') return [`${platform}-${arch}`]
  return musl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`]
}

// The SDK's `exports` map hides its package.json, so find the package directory
// from its resolvable entry point and read the file directly.
function packageVersion(name) {
  try {
    return requireFromHere(`${name}/package.json`).version
  } catch {
    // fall through to the directory walk
  }
  try {
    let dir = join(requireFromHere.resolve(name), '..')
    for (let i = 0; i < 8; i += 1) {
      const file = join(dir, 'package.json')
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8'))
        if (pkg.name === name) return pkg.version
      }
      dir = join(dir, '..')
    }
  } catch {
    // not installed
  }
  return undefined
}

export function sdkPinnedVersion() {
  return packageVersion('@anthropic-ai/claude-agent-sdk')
}

export function privateCliBinary(opts = {}) {
  const [first] = platformPackages(opts)
  return join(privateCliPrefix(opts), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${first}`, exeName())
}

const stateFile = (opts) => join(privateCliPrefix(opts), 'state.json')
const lockDir = (opts) => join(privateCliPrefix(opts), '.install.lock')

function readState(opts) {
  try {
    return JSON.parse(readFileSync(stateFile(opts), 'utf8'))
  } catch {
    return {}
  }
}

function writeState(opts, state) {
  try {
    mkdirSync(privateCliPrefix(opts), { recursive: true })
    writeFileSync(stateFile(opts), JSON.stringify(state))
  } catch {
    // state is advisory; losing it only means one extra attempt
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Take the install lock, or return undefined when a live installer holds it. */
function acquireLock(opts) {
  const dir = lockDir(opts)
  mkdirSync(privateCliPrefix(opts), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
      return () => rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'EEXIST') return undefined
      let owner = {}
      try { owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) } catch { /* unreadable = stale */ }
      const stale = Date.now() - Number(owner.at ?? 0) > (opts.lockStaleMs ?? DEFAULTS.lockStaleMs)
      if (pidAlive(owner.pid) && !stale && owner.pid !== process.pid) return undefined
      if (owner.pid === process.pid && !stale) return undefined // another call in THIS process holds it
      rmSync(dir, { recursive: true, force: true }) // dead or stale owner: take over
    }
  }
  return undefined
}

async function verify(run, path, opts) {
  const r = await run(path, ['--version'], { timeoutMs: opts.versionTimeoutMs ?? DEFAULTS.versionTimeoutMs })
  const out = `${r.stdout}`.trim()
  if (r.code !== 0 || !out) throw new Error(`installed binary did not report a version (exit ${r.code})`)
  return out
}

const inFlight = new Map() // prefix -> Promise of the install running in THIS process

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Make sure a Claude CLI exists. Looks first; installs only when missing.
 * Concurrent callers share one install: in this process through the in-flight
 * promise, across processes through the lock plus a bounded wait for its result.
 * @returns {Promise<{action:'none'|'installed'|'skipped'|'failed'|'busy', source?, path?, version?, reason?, error?}>}
 */
export async function ensureClaudeCli(options = {}) {
  const key = privateCliPrefix(options)
  const running = inFlight.get(key)
  if (running && !options.force) return running
  const task = ensureClaudeCliOnce(options)
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key)
  }
}

async function ensureClaudeCliOnce(options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const run = opts.run ?? runProcess
  try {
    const existing = locateClaude({ explicit: opts.explicit, sdkBinaryDirs: opts.sdkBinaryDirs, stateDir: opts.stateDir, dshHome: opts.dshHome, homeDir: opts.homeDir, env: opts.env })
    if (existing) return { action: 'none', source: existing.source, path: existing.path }
    if (opts.explicit) return { action: 'skipped', reason: 'configured-path-missing', path: opts.explicit }
    if (opts.autoInstall === false) return { action: 'skipped', reason: 'disabled' }

    const state = readState(opts)
    if (!opts.force && state.failedAt && Date.now() - state.failedAt < opts.retryMs) {
      return { action: 'skipped', reason: 'recent-failure', error: state.error }
    }

    const release = acquireLock(opts)
    if (!release) {
      // Another process is installing. Wait (bounded) for its binary, then use it.
      const until = Date.now() + (opts.waitForOtherMs ?? 3 * 60_000)
      while (Date.now() < until) {
        await sleep(opts.pollMs ?? 500)
        const done = locateClaude({ sdkBinaryDirs: opts.sdkBinaryDirs, stateDir: opts.stateDir, dshHome: opts.dshHome, homeDir: opts.homeDir, env: opts.env })
        if (done) return { action: 'none', source: done.source, path: done.path }
      }
      return { action: 'busy' }
    }
    try {
      // Another process may have finished while we waited for the lock.
      const raced = locateClaude({ sdkBinaryDirs: opts.sdkBinaryDirs, stateDir: opts.stateDir, dshHome: opts.dshHome, homeDir: opts.homeDir, env: opts.env })
      if (raced) return { action: 'none', source: raced.source, path: raced.path }

      const version = opts.sdkVersion ?? sdkPinnedVersion()
      const [pkg] = platformPackages(opts)
      const spec = `@anthropic-ai/claude-agent-sdk-${pkg}${version ? `@${version}` : ''}`
      const prefix = privateCliPrefix(opts)
      const args = ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', '--loglevel', 'error', spec]
      let last
      for (const tool of ['npm', 'pnpm']) {
        try {
          const r = await run(tool, tool === 'pnpm' ? ['add', '--dir', prefix, spec] : args, { timeoutMs: opts.installTimeoutMs, env: { ...(opts.env ?? process.env) } })
          if (r.code !== 0) throw new Error(`${tool} exited ${r.code}: ${String(r.stderr || r.stdout).trim().slice(-400)}`)
          last = undefined
          break
        } catch (error) {
          last = error
          if (error?.code !== 'ENOENT') break // a real failure: do not mask it by trying another tool
        }
      }
      if (last) {
        const missingTools = last.code === 'ENOENT'
        throw new Error(missingTools ? 'neither npm nor pnpm is available to install the Claude Code CLI' : String(last.message ?? last))
      }
      const path = privateCliBinary(opts)
      const found = locateClaude({ sdkBinaryDirs: [], stateDir: opts.stateDir, dshHome: opts.dshHome, homeDir: opts.homeDir, env: { PATH: '' } })
      if (!found || !existsSync(path)) throw new Error(`install finished but no binary was found at ${path}`)
      const reported = await verify(run, found.path, opts)
      writeState(opts, { installedAt: Date.now(), version: reported, spec })
      return { action: 'installed', source: 'private', path: found.path, version: reported }
    } finally {
      release()
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    writeState(opts, { failedAt: Date.now(), error: message })
    return { action: 'failed', error: message }
  }
}

const check = (ok, extra = {}) => ({ ok, ...extra })

/**
 * Report the state of every dependency without installing or changing anything.
 */
export async function inspectDeps(options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const run = opts.run ?? runProcess
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const out = {
    node: check(nodeMajor >= 22, { version: process.versions.node }),
    sdk: check(false),
    zod: check(false),
    claude: check(false),
    login: { state: 'unknown' },
  }
  const sdkVersion = packageVersion('@anthropic-ai/claude-agent-sdk')
  if (sdkVersion) out.sdk = check(true, { version: sdkVersion })
  const zodVersion = packageVersion('zod')
  if (zodVersion) out.zod = check(true, { version: zodVersion })
  const hit = locateClaude({ explicit: opts.explicit, sdkBinaryDirs: opts.sdkBinaryDirs, stateDir: opts.stateDir, dshHome: opts.dshHome, homeDir: opts.homeDir, env: opts.env })
  if (hit) {
    out.claude = check(true, { path: hit.path, source: hit.source })
    try {
      const r = await run(hit.path, ['--version'], { timeoutMs: opts.versionTimeoutMs })
      if (r.code === 0) out.claude.version = r.stdout.trim()
    } catch (error) {
      out.claude = check(false, { path: hit.path, source: hit.source, error: String(error?.message ?? error) })
    }
    if (opts.checkLogin && out.claude.ok) {
      try {
        const r = await run(hit.path, ['auth', 'status'], { timeoutMs: opts.versionTimeoutMs })
        const status = JSON.parse(r.stdout)
        out.login = { state: status.loggedIn ? 'logged-in' : 'logged-out' }
      } catch {
        out.login = { state: 'unknown' }
      }
    }
  }
  return out
}
