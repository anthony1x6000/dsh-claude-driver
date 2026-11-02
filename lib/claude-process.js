// What every Claude Code CLI process the driver starts inherits:
//   * a low scheduling priority, so model work yields to the rest of the host;
//   * CLAUDE_CODE_ENTRYPOINT=t3-code, with Claude's own settings env winning —
//     the merge from pingdotgg/t3code#28410.
import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, setPriority } from 'node:os'
import { join, resolve } from 'node:path'

export const CLAUDE_ENTRYPOINT = 't3-code'
export const CLIENT_APP = 'dsh-claude-driver/0.1.0'
export const LOWEST_PRIORITY = 19

/** Config `nice` -> a schedulable priority, or false to leave the default. */
export function normalizeNice(value) {
  if (value === false) return false
  if (value === undefined || value === null || value === '') return LOWEST_PRIORITY
  const level = Number(value)
  if (!Number.isFinite(level)) return LOWEST_PRIORITY
  return Math.max(0, Math.min(LOWEST_PRIORITY, Math.trunc(level)))
}

/** Lower a running process's priority. Never throws: restricted hosts keep the default. */
export function lowerPriority(pid, level = LOWEST_PRIORITY) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const nice = normalizeNice(level)
  if (nice === false) return false
  try {
    setPriority(pid, nice)
    return true
  } catch {
    return false
  }
}

/** Start a child, then drop it to `level` before it can do meaningful work. */
export function spawnPrioritized(command, args, { level = LOWEST_PRIORITY, spawn = nodeSpawn, ...options } = {}) {
  const child = spawn(command, args, options)
  if (level !== false) lowerPriority(child?.pid, level)
  return child
}

/**
 * SDK `spawnClaudeCodeProcess` hook: the SDK's own local spawn (piped stdio,
 * windowsHide) plus the priority drop.
 */
export function lowPrioritySpawn(level = LOWEST_PRIORITY) {
  return ({ command, args, cwd, env, signal }) =>
    spawnPrioritized(command, args, {
      level,
      cwd,
      env,
      signal,
      // The SDK's custom-spawn path drains stdin/stdout but never stderr; a
      // piped stderr fills after ~64 KB and blocks the CLI. Let the OS discard it.
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
}

/** Attach the spawn hook to one SDK options object. false disables it. */
export function applyClaudePriority(options, nice) {
  const level = normalizeNice(nice)
  if (level === false) delete options.spawnClaudeCodeProcess
  else options.spawnClaudeCodeProcess = lowPrioritySpawn(level)
  return options
}

function managedSettingsPath(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (platform === 'win32') {
    const programData = env.PROGRAMDATA?.trim()
    return programData ? join(programData, 'ClaudeCode', 'managed-settings.json') : undefined
  }
  return '/etc/claude-code/managed-settings.json'
}

export function claudeConfigDir({ env = process.env, configDir } = {}) {
  const configured = configDir ?? env.CLAUDE_CONFIG_DIR?.trim()
  if (configured) return resolve(configured)
  const home = env.HOME?.trim() || homedir()
  return join(home, '.claude')
}

/** Claude Code settings files whose `env` block can name the entrypoint. */
export function claudeSettingsPaths({ env = process.env, configDir, managedPath, platform = process.platform } = {}) {
  const paths = [join(claudeConfigDir({ env, configDir }), 'settings.json')]
  const managed = managedPath ?? managedSettingsPath(platform, env)
  if (managed) paths.push(managed)
  return paths
}

/** Read `env` from Claude's user and managed settings; later files win. */
export function readClaudeSettingsEnv(options = {}) {
  const env = {}
  for (const file of claudeSettingsPaths(options)) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      continue
    }
    const values = parsed?.env
    if (values && typeof values === 'object' && !Array.isArray(values)) Object.assign(env, values)
  }
  return env
}

/**
 * Environment for a Claude child. The host entrypoint is replaced (a host
 * started inside another Claude app must not leak its label), then Claude's
 * settings env wins, exactly as the CLI applies it.
 */
export function claudeProcessEnv({
  proxy,
  env: hostEnv = process.env,
  entrypoint = CLAUDE_ENTRYPOINT,
  clientApp = CLIENT_APP,
  configDir,
  managedPath,
  platform = process.platform,
} = {}) {
  const env = {
    ...hostEnv,
    CLAUDE_AGENT_SDK_CLIENT_APP: clientApp,
    CLAUDE_CODE_ENTRYPOINT: entrypoint,
  }
  if (proxy) {
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
    env.ALL_PROXY = proxy
    env.NO_PROXY = 'localhost,127.0.0.1,::1'
  }
  const fromSettings = readClaudeSettingsEnv({ env: hostEnv, configDir, managedPath, platform }).CLAUDE_CODE_ENTRYPOINT
  if (typeof fromSettings === 'string' && fromSettings.trim()) env.CLAUDE_CODE_ENTRYPOINT = fromSettings.trim()
  return env
}
