// Locate a Claude Code CLI binary for the Agent SDK.
//
// Order (first hit wins; an explicit path always wins and is never second-guessed):
//   1. configured `pathToClaudeCodeExecutable`
//   2. the SDK's own bundled platform binary (optional dependency of the SDK)
//   3. the driver's private install (see deps.js ensureClaudeCli)
//   4. well-known per-user locations (`~/.local/bin/claude`, `~/.claude/local/claude`)
//   5. `claude` on PATH
//
// When the SDK's own binary resolves (2) the SDK default resolution is left
// untouched (undefined is returned); otherwise the located path is returned.
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

const requireFromHere = createRequire(import.meta.url)

let cached // undefined = not probed; null = nothing to override; string = explicit path

export function resetClaudeExecutableCache() {
  cached = undefined
}

const exeName = () => (process.platform === 'win32' ? 'claude.exe' : 'claude')

function isRunnableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Directories that hold the SDK's bundled platform binary, if resolvable. */
export function sdkBundledBinaryDirs() {
  let sdkRequire
  try {
    sdkRequire = createRequire(requireFromHere.resolve('@anthropic-ai/claude-agent-sdk'))
  } catch {
    return []
  }
  const suffixes = process.platform === 'linux'
    ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
    : [`${process.platform}-${process.arch}`]
  const dirs = []
  for (const suffix of suffixes) {
    try {
      const found = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/${exeName()}`)
      if (existsSync(found)) dirs.push(join(found, '..'))
    } catch {
      // keep probing
    }
  }
  return dirs
}

/** Where the driver installs the CLI itself. */
export function privateCliPrefix(opts = {}) {
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(opts.homeDir ?? homedir(), '.dsh')
  const stateDir = opts.stateDir ?? join(dshHome, 'storages', 'claude-driver')
  return join(stateDir, 'cli')
}

function privateCandidates(opts) {
  const prefix = privateCliPrefix(opts)
  const scope = join(prefix, 'node_modules', '@anthropic-ai')
  const suffixes = process.platform === 'linux'
    ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
    : [`${process.platform}-${process.arch}`]
  return suffixes.map((s) => join(scope, `claude-agent-sdk-${s}`, exeName()))
}

function knownLocations(opts) {
  const home = opts.homeDir ?? process.env.HOME ?? homedir()
  if (process.platform === 'win32') {
    const npmGlobal = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined
    if (!npmGlobal) return []
    const pkg = join(npmGlobal, 'node_modules', '@anthropic-ai', 'claude-code')
    return [
      join(pkg, 'node_modules', '@anthropic-ai', `claude-code-win32-${process.arch}`, 'claude.exe'),
      join(pkg, 'bin', 'claude.exe'),
    ]
  }
  return home ? [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude')] : []
}

function onPath(env) {
  const path = (env ?? process.env).PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exeName())
    if (isRunnableFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Find a usable Claude CLI without running anything.
 * @returns `{ path, source }` or undefined. `source` is one of
 *   configured | sdk-bundled | private | known-location | path.
 */
export function locateClaude(opts = {}) {
  if (opts.explicit) return isRunnableFile(opts.explicit) ? { path: opts.explicit, source: 'configured' } : undefined
  const dirs = opts.sdkBinaryDirs ?? sdkBundledBinaryDirs()
  for (const dir of dirs) {
    const candidate = join(dir, exeName())
    if (existsSync(candidate)) return { path: candidate, source: 'sdk-bundled' }
  }
  for (const candidate of privateCandidates(opts)) {
    if (isRunnableFile(candidate)) return { path: candidate, source: 'private' }
  }
  for (const candidate of knownLocations(opts)) {
    if (isRunnableFile(candidate)) return { path: candidate, source: 'known-location' }
  }
  const found = onPath(opts.env)
  return found ? { path: found, source: 'path' } : undefined
}

/**
 * Resolve the `pathToClaudeCodeExecutable` SDK option.
 * @param explicit — configured override (wins unconditionally).
 * @returns an absolute path when a fallback binary is needed and found,
 *   otherwise `undefined` (SDK default resolution is left untouched).
 */
export function resolveClaudeExecutable(explicit, opts = {}) {
  if (explicit) return explicit
  if (cached !== undefined) return cached ?? undefined
  const hit = locateClaude(opts)
  if (!hit || hit.source === 'sdk-bundled') {
    cached = null
    return undefined
  }
  cached = hit.path
  return hit.path
}
