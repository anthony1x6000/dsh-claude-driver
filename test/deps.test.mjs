// Dependency check + auto-install of the Claude Code CLI binary.
// Rule one: look first, install only what is missing, never twice, never concurrently.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureClaudeCli, inspectDeps, platformPackages, privateCliBinary } from '../lib/deps.js'
import { locateClaude, resetClaudeExecutableCache, resolveClaudeExecutable } from '../lib/claude-executable.js'

const tmp = (p) => mkdtempSync(join(tmpdir(), `deps-${p}-`))
const fakeBinary = (path, version = '9.9.9') => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`)
  chmodSync(path, 0o755)
}
// A world with NO claude anywhere: private dir empty, no SDK binary, empty PATH.
function emptyWorld() {
  const stateDir = tmp('state')
  return { stateDir, homeDir: tmp('home'), env: { PATH: tmp('path') }, sdkBinaryDirs: [], retryMs: 3_600_000 }
}
// An installer double that records calls and, on success, lays down the binary like npm would.
function fakeRun(world, { createBinary = true, fail } = {}) {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'npm' || cmd === 'pnpm') {
      if (fail) throw new Error(fail)
      if (createBinary) fakeBinary(privateCliBinary(world))
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '9.9.9 (Claude Code)\n', stderr: '' } // `<claude> --version`
  }
  run.calls = calls
  return run
}
const installs = (run) => run.calls.filter(([c]) => c === 'npm' || c === 'pnpm')

test('platformPackages: glibc linux prefers the gnu build, musl prefers musl, others are exact', () => {
  assert.deepEqual(platformPackages({ platform: 'linux', arch: 'x64', musl: false }), ['linux-x64', 'linux-x64-musl'])
  assert.deepEqual(platformPackages({ platform: 'linux', arch: 'arm64', musl: true }), ['linux-arm64-musl', 'linux-arm64'])
  assert.deepEqual(platformPackages({ platform: 'darwin', arch: 'arm64' }), ['darwin-arm64'])
})

test('already installed (PATH claude): nothing is run, nothing is installed', async () => {
  const w = emptyWorld()
  fakeBinary(join(w.env.PATH, 'claude'))
  const run = fakeRun(w)
  const r = await ensureClaudeCli({ ...w, run })
  assert.equal(r.action, 'none')
  assert.equal(r.source, 'path')
  assert.equal(installs(run).length, 0)
})

test('already installed (SDK bundled binary): found without executing anything', async () => {
  const w = emptyWorld()
  const sdkDir = tmp('sdk')
  fakeBinary(join(sdkDir, 'claude'))
  const run = fakeRun(w)
  const r = await ensureClaudeCli({ ...w, sdkBinaryDirs: [sdkDir], run })
  assert.equal(r.action, 'none')
  assert.equal(r.source, 'sdk-bundled')
  assert.equal(run.calls.length, 0, 'the bundled binary is trusted by presence; no process spawned')
})

test('an explicitly configured executable is never second-guessed or replaced', async () => {
  const w = emptyWorld()
  const explicit = join(tmp('x'), 'my-claude'); fakeBinary(explicit)
  const run = fakeRun(w)
  const r = await ensureClaudeCli({ ...w, explicit, run })
  assert.equal(r.action, 'none'); assert.equal(r.source, 'configured')
  assert.equal(run.calls.length, 0)
})

test('a configured path that does not exist is reported, not silently replaced by an install', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  const r = await ensureClaudeCli({ ...w, explicit: '/nope/claude', run })
  assert.equal(r.action, 'skipped'); assert.equal(r.reason, 'configured-path-missing')
  assert.equal(installs(run).length, 0)
})

test('missing: installs exactly the SDK-pinned platform package into the private prefix, then verifies it runs', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  const r = await ensureClaudeCli({ ...w, run, sdkVersion: '0.3.312', platform: 'linux', arch: 'x64', musl: false })
  assert.equal(r.action, 'installed')
  assert.equal(r.path, privateCliBinary(w))
  const [[cmd, ...args]] = installs(run)
  assert.equal(cmd, 'npm')
  assert.ok(args.includes('install'))
  assert.ok(args.includes('--prefix') && args.includes(join(w.stateDir, 'cli')), args.join(' '))
  assert.ok(args.includes('@anthropic-ai/claude-agent-sdk-linux-x64@0.3.312'), args.join(' '))
  assert.ok(run.calls.some(([c, a]) => c === r.path && a === '--version'), 'verified by running --version')
})

test('after an install the next check finds it and installs nothing (idempotent)', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  await ensureClaudeCli({ ...w, run })
  const again = await ensureClaudeCli({ ...w, run })
  assert.equal(again.action, 'none'); assert.equal(again.source, 'private')
  assert.equal(installs(run).length, 1)
})

test('autoInstall:false never installs; it only reports', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  const r = await ensureClaudeCli({ ...w, run, autoInstall: false })
  assert.equal(r.action, 'skipped'); assert.equal(r.reason, 'disabled')
  assert.equal(run.calls.length, 0)
})

test('two processes starting together install once (lock)', async () => {
  const w = emptyWorld()
  const run = fakeRun(w)
  const slow = async (...a) => { if (a[0] === 'npm') await new Promise((r) => setTimeout(r, 80)); return run(...a) }
  slow.calls = run.calls
  const [a, b] = await Promise.all([ensureClaudeCli({ ...w, run: slow }), ensureClaudeCli({ ...w, run: slow })])
  assert.equal(installs(run).length, 1)
  assert.equal(a.path, b.path)
  assert.ok([a.action, b.action].includes('installed'))
})

test('a lock left by a dead process does not block forever', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  const lock = join(w.stateDir, 'cli', '.install.lock'); mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2_999_999, at: Date.now() }))
  const r = await ensureClaudeCli({ ...w, run })
  assert.equal(r.action, 'installed')
})

test('a lock older than the stale limit is taken over even if its pid looks alive', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  const lock = join(w.stateDir, 'cli', '.install.lock'); mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() - 3 * 3_600_000 }))
  const r = await ensureClaudeCli({ ...w, run, lockStaleMs: 60_000 })
  assert.equal(r.action, 'installed')
})

test('a failed install is reported without throwing, and is not retried until the backoff passes', async () => {
  const w = emptyWorld(); const run = fakeRun(w, { fail: 'EAI_AGAIN offline' })
  const first = await ensureClaudeCli({ ...w, run })
  assert.equal(first.action, 'failed'); assert.match(first.error, /EAI_AGAIN offline/)
  const second = await ensureClaudeCli({ ...w, run })
  assert.equal(second.action, 'skipped'); assert.equal(second.reason, 'recent-failure')
  assert.equal(installs(run).length, 1, 'no retry loop')
  const forced = await ensureClaudeCli({ ...w, run, force: true })
  assert.equal(forced.action, 'failed')
  assert.equal(installs(run).length, 2)
})

test('the failure backoff expires', async () => {
  const w = emptyWorld(); const run = fakeRun(w, { fail: 'boom' })
  await ensureClaudeCli({ ...w, run })
  const later = await ensureClaudeCli({ ...w, run, retryMs: 0 })
  assert.equal(later.action, 'failed')
  assert.equal(installs(run).length, 2)
})

test('npm "succeeds" but leaves no binary: reported as failed, not as installed', async () => {
  const w = emptyWorld(); const run = fakeRun(w, { createBinary: false })
  const r = await ensureClaudeCli({ ...w, run })
  assert.equal(r.action, 'failed'); assert.match(r.error, /not found|no binary|did not/i)
})

test('an installed binary that cannot run is reported as failed', async () => {
  const w = emptyWorld()
  const run = async (cmd, args) => { run.calls.push([cmd, ...args]); if (cmd === 'npm') { fakeBinary(privateCliBinary(w)); return { code: 0, stdout: '', stderr: '' } } throw new Error('Exec format error') }
  run.calls = []
  const r = await ensureClaudeCli({ ...w, run })
  assert.equal(r.action, 'failed'); assert.match(r.error, /Exec format error/)
})

test('no npm available: falls back to pnpm, and says so clearly when neither exists', async () => {
  const w = emptyWorld()
  const noNpm = async (cmd, args) => { noNpm.calls.push([cmd, ...args]); if (cmd === 'npm') { const e = new Error('spawn npm ENOENT'); e.code = 'ENOENT'; throw e } fakeBinary(privateCliBinary(w)); return { code: 0, stdout: '9.9.9', stderr: '' } }
  noNpm.calls = []
  const r = await ensureClaudeCli({ ...w, run: noNpm })
  assert.equal(r.action, 'installed')
  assert.deepEqual(noNpm.calls.filter(([c]) => c === 'npm' || c === 'pnpm').map(([c]) => c), ['npm', 'pnpm'])
  const w2 = emptyWorld()
  const none = async () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e }
  const r2 = await ensureClaudeCli({ ...w2, run: none })
  assert.equal(r2.action, 'failed'); assert.match(r2.error, /npm|pnpm/)
})

test('the install is bounded by a timeout it passes down', async () => {
  const w = emptyWorld(); let seen
  const run = async (cmd, args, o) => { if (cmd === 'npm') { seen = o; fakeBinary(privateCliBinary(w)) } return { code: 0, stdout: '1', stderr: '' } }
  await ensureClaudeCli({ ...w, run, installTimeoutMs: 123_000 })
  assert.equal(seen.timeoutMs, 123_000)
})

test('locateClaude order: configured > SDK-bundled > private prefix > known locations > PATH', () => {
  const w = emptyWorld()
  const sdkDir = tmp('sdk'); fakeBinary(join(sdkDir, 'claude'))
  fakeBinary(privateCliBinary(w)); fakeBinary(join(w.env.PATH, 'claude'))
  assert.equal(locateClaude({ ...w, sdkBinaryDirs: [sdkDir] }).source, 'sdk-bundled')
  assert.equal(locateClaude({ ...w }).source, 'private')
  const w3 = emptyWorld(); fakeBinary(join(w3.env.PATH, 'claude'))
  assert.equal(locateClaude(w3).source, 'path')
  assert.equal(locateClaude(emptyWorld()), undefined)
})

test('resolveClaudeExecutable hands the SDK the private binary when nothing else exists', () => {
  resetClaudeExecutableCache()
  const w = emptyWorld(); fakeBinary(privateCliBinary(w))
  assert.equal(resolveClaudeExecutable(undefined, w), privateCliBinary(w))
  resetClaudeExecutableCache()
  assert.equal(resolveClaudeExecutable('/explicit/claude', w), '/explicit/claude')
  resetClaudeExecutableCache()
})

test('inspectDeps reports every dependency with a state and never installs', async () => {
  const w = emptyWorld(); fakeBinary(join(w.env.PATH, 'claude'))
  const run = async (cmd, args) => { run.calls.push([cmd, ...args]); return args[0] === 'auth' ? { code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' } : { code: 0, stdout: '9.9.9 (Claude Code)', stderr: '' } }
  run.calls = []
  const d = await inspectDeps({ ...w, run, checkLogin: true })
  assert.equal(d.node.ok, true)
  assert.equal(d.sdk.ok, true)
  assert.equal(d.zod.ok, true)
  assert.equal(d.claude.ok, true); assert.equal(d.claude.version, '9.9.9 (Claude Code)')
  assert.equal(d.login.state, 'logged-out')
  assert.equal(run.calls.filter(([c]) => c === 'npm' || c === 'pnpm').length, 0)
})

test('inspectDeps with nothing installed says exactly what is missing', async () => {
  const d = await inspectDeps({ ...emptyWorld(), run: fakeRun(emptyWorld()) })
  assert.equal(d.claude.ok, false)
  assert.equal(d.login.state, 'unknown')
})

test('state files stay inside the driver-owned directory', async () => {
  const w = emptyWorld(); const run = fakeRun(w, { fail: 'x' })
  await ensureClaudeCli({ ...w, run })
  assert.ok(existsSync(join(w.stateDir, 'cli', 'state.json')))
  assert.match(readFileSync(join(w.stateDir, 'cli', 'state.json'), 'utf8'), /failedAt/)
})

test('the SDK version pin is really read (its exports map hides package.json)', async () => {
  const { sdkPinnedVersion } = await import('../lib/deps.js')
  assert.match(sdkPinnedVersion(), /^\d+\.\d+\.\d+/)
})

test('without an explicit sdkVersion the install spec carries the installed SDK version', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  await ensureClaudeCli({ ...w, run })
  const [[, ...args]] = installs(run)
  assert.ok(args.some((a) => /^@anthropic-ai\/claude-agent-sdk-linux-x64(-musl)?@\d+\.\d+\.\d+/.test(a)), `unpinned install spec: ${args.join(' ')}`)
})

test('a second call in the SAME process waits for the install in flight and shares its result (no "busy")', async () => {
  const w = emptyWorld(); const run = fakeRun(w)
  const slow = async (...a) => { if (a[0] === 'npm') await new Promise((r) => setTimeout(r, 80)); return run(...a) }
  slow.calls = run.calls
  // pollMs is huge: a caller that fell back to polling the lock would take a minute.
  const first = ensureClaudeCli({ ...w, run: slow, pollMs: 60_000 })
  await new Promise((r) => setTimeout(r, 10))
  const t0 = Date.now()
  const second = ensureClaudeCli({ ...w, run: slow, pollMs: 60_000 })
  const [a, b] = await Promise.all([first, second])
  assert.ok(Date.now() - t0 < 5_000, 'shared the in-flight install instead of polling')
  assert.equal(installs(run).length, 1)
  assert.equal(a.action, 'installed')
  assert.ok(['installed', 'none'].includes(b.action), b.action)
  assert.equal(b.path, a.path)
})

test('a call in ANOTHER process that finds the lock held waits (bounded) for the binary instead of failing', async () => {
  const w = emptyWorld()
  const lock = join(w.stateDir, 'cli', '.install.lock'); mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, at: Date.now() }))
  setTimeout(() => fakeBinary(privateCliBinary(w)), 120)
  const r = await ensureClaudeCli({ ...w, run: fakeRun(w, { createBinary: false }), waitForOtherMs: 2000, pollMs: 20 })
  assert.equal(r.action, 'none'); assert.equal(r.source, 'private')
})

test('waiting for another installer is bounded: it gives up as busy after the limit', async () => {
  const w = emptyWorld()
  const lock = join(w.stateDir, 'cli', '.install.lock'); mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, at: Date.now() }))
  const t0 = Date.now()
  const r = await ensureClaudeCli({ ...w, run: fakeRun(w, { createBinary: false }), waitForOtherMs: 150, pollMs: 20 })
  assert.equal(r.action, 'busy')
  assert.ok(Date.now() - t0 < 1500)
})
