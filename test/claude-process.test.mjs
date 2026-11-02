// Process policy for every Claude Code CLI the driver starts:
//   * nice 19 by default, so model work yields to the rest of the machine;
//   * CLAUDE_CODE_ENTRYPOINT=t3-code, with Claude's settings env winning —
//     the merge from pingdotgg/t3code#28410.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { getPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CLAUDE_ENTRYPOINT,
  LOWEST_PRIORITY,
  claudeProcessEnv,
  lowerPriority,
  normalizeNice,
  readClaudeSettingsEnv,
  spawnPrioritized,
} from '../lib/claude-process.js'

const temp = (prefix) => mkdtempSync(join(tmpdir(), `claude-${prefix}-`))
const writeSettings = (dir, env, file = 'settings.json') =>
  writeFileSync(join(dir, file), JSON.stringify({ env }))
const missingSettings = () => join(temp('missing'), 'settings.json')

test('nice defaults to 19 and clamps to the unprivileged range', () => {
  assert.equal(CLAUDE_ENTRYPOINT, 't3-code')
  assert.equal(LOWEST_PRIORITY, 19)
  assert.equal(normalizeNice(undefined), LOWEST_PRIORITY)
  assert.equal(normalizeNice(10), 10)
  assert.equal(normalizeNice(0), 0)
  assert.equal(normalizeNice(99), LOWEST_PRIORITY)
  assert.equal(normalizeNice(-5), 0)
  assert.equal(normalizeNice(12.9), 12)
  assert.equal(normalizeNice(false), false)
  assert.equal(normalizeNice('nope'), LOWEST_PRIORITY)
})

test('lowerPriority ignores missing pids', () => {
  assert.equal(lowerPriority(undefined, 19), false)
  assert.equal(lowerPriority(0, 19), false)
  assert.equal(lowerPriority(-1, 19), false)
})

test('a spawned child really gets the requested nice value', async () => {
  const child = spawnPrioritized(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 5000)'],
    { level: 19, stdio: ['ignore', 'ignore', 'ignore'] },
  )
  try {
    await once(child, 'spawn')
    assert.equal(getPriority(child.pid), 19)
  } finally {
    child.kill('SIGKILL')
  }
})

test('the SDK spawn shape keeps piped stdio, env, and the nice drop', async () => {
  const child = spawnPrioritized(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write(process.env.MARK || ""), 100)'],
    {
      level: 19,
      env: { ...process.env, MARK: 'piped' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  try {
    await once(child, 'spawn')
    assert.equal(getPriority(child.pid), 19)
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
    assert.equal(output, 'piped')
  } finally {
    child.kill('SIGKILL')
  }
})

test('t3-code replaces an inherited entrypoint and keeps the host environment', () => {
  const env = claudeProcessEnv({
    env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', KEEP: '1' },
    configDir: temp('empty'),
    managedPath: missingSettings(),
  })
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, CLAUDE_ENTRYPOINT)
  assert.equal(env.KEEP, '1')
  assert.equal(typeof env.CLAUDE_AGENT_SDK_CLIENT_APP, 'string')
})

test('proxy settings still land in the environment', () => {
  const env = claudeProcessEnv({
    proxy: 'http://10.0.0.1:3128',
    env: {},
    configDir: temp('empty'),
    managedPath: missingSettings(),
  })
  assert.equal(env.HTTPS_PROXY, 'http://10.0.0.1:3128')
  assert.equal(env.HTTP_PROXY, 'http://10.0.0.1:3128')
  assert.equal(env.ALL_PROXY, 'http://10.0.0.1:3128')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1')
})

test('Claude settings env overrides both the host and the t3-code default', () => {
  const dir = temp('user')
  writeSettings(dir, { CLAUDE_CODE_ENTRYPOINT: 'custom' })
  const env = claudeProcessEnv({
    env: { CLAUDE_CODE_ENTRYPOINT: 'host' },
    configDir: dir,
    managedPath: missingSettings(),
  })
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'custom')
})

test('managed settings win over user settings, like Claude Code precedence', () => {
  const user = temp('user')
  const managedDir = temp('managed')
  const managed = join(managedDir, 'managed-settings.json')
  writeSettings(user, { CLAUDE_CODE_ENTRYPOINT: 'user' })
  writeFileSync(managed, JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: 'managed' } }))
  const env = claudeProcessEnv({ env: {}, configDir: user, managedPath: managed })
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'managed')
})

test('CLAUDE_CONFIG_DIR selects the settings directory', () => {
  const dir = temp('config-dir')
  writeSettings(dir, { CLAUDE_CODE_ENTRYPOINT: 'config-dir' })
  const env = claudeProcessEnv({
    env: { CLAUDE_CONFIG_DIR: dir },
    managedPath: missingSettings(),
  })
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'config-dir')
})

test('missing, malformed, empty, or non-string settings fall back to t3-code', () => {
  const malformed = temp('malformed')
  writeFileSync(join(malformed, 'settings.json'), '{not json')
  assert.equal(
    claudeProcessEnv({ env: {}, configDir: malformed, managedPath: missingSettings() }).CLAUDE_CODE_ENTRYPOINT,
    CLAUDE_ENTRYPOINT,
  )

  for (const value of ['', '   ', 42, null, {}]) {
    const dir = temp('settings')
    writeSettings(dir, { CLAUDE_CODE_ENTRYPOINT: value })
    assert.equal(
      claudeProcessEnv({ env: {}, configDir: dir, managedPath: missingSettings() }).CLAUDE_CODE_ENTRYPOINT,
      CLAUDE_ENTRYPOINT,
      String(value),
    )
  }
})

test('readClaudeSettingsEnv returns the settings env values it reads', () => {
  const dir = temp('read')
  writeSettings(dir, { CLAUDE_CODE_ENTRYPOINT: 'x', ANTHROPIC_BASE_URL: 'http://api' })
  assert.deepEqual(
    readClaudeSettingsEnv({ env: {}, configDir: dir, managedPath: missingSettings() }),
    { CLAUDE_CODE_ENTRYPOINT: 'x', ANTHROPIC_BASE_URL: 'http://api' },
  )
})
