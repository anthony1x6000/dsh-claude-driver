// Every SDK query the driver starts — main turns, prewarm, model discovery,
// native compaction, subagents — must carry the low-priority spawn hook and
// the t3-code entrypoint. The turn and discovery paths share buildSdkOptions;
// the subagent provider assembles its own options and is covered separately.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildSdkOptions, discoverClaudeModels } from '../lib/index.js'
import { createClaudeCodeProvider } from '../lib/subagent-provider.js'
import { CLAUDE_ENTRYPOINT } from '../lib/claude-process.js'

// Keep the assertions deterministic when the host has its own Claude settings.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'claude-wiring-'))

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const turn = {
  provider: 'claude-code',
  model: 'sonnet',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
}
const optionsFor = (settings) =>
  buildSdkOptions(ctx, turn, settings, { controller: new AbortController(), model: 'sonnet' })
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms)),
  ])

test('a main-model turn spawns through the low-priority hook', () => {
  const sdk = optionsFor({ model: 'sonnet', nice: 19 })
  assert.equal(typeof sdk.spawnClaudeCodeProcess, 'function')
  assert.equal(sdk.env.CLAUDE_CODE_ENTRYPOINT, CLAUDE_ENTRYPOINT)
})

test('nice:false restores the SDK default spawn but keeps the t3-code entrypoint', () => {
  const sdk = optionsFor({ model: 'sonnet', nice: false })
  assert.equal(sdk.spawnClaudeCodeProcess, undefined)
  assert.equal(sdk.env.CLAUDE_CODE_ENTRYPOINT, CLAUDE_ENTRYPOINT)
})

test('model discovery spawns through the low-priority hook', async () => {
  let seen
  const queryImpl = ({ options }) => {
    seen = options
    return { supportedModels: async () => [] }
  }
  await discoverClaudeModels(ctx, { nice: 19, queryImpl })
  assert.equal(typeof seen.spawnClaudeCodeProcess, 'function')
  assert.equal(seen.env.CLAUDE_CODE_ENTRYPOINT, CLAUDE_ENTRYPOINT)
  assert.equal(seen.abortController.signal.aborted, true, 'discovery still aborts its process')
})

test('the claude-code subagent spawns through the low-priority hook', async () => {
  let seen
  const provider = createClaudeCodeProvider({
    nice: 19,
    queryImpl: ({ options }) => {
      seen = options
      return (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
      })()
    },
  })
  const handle = await provider.start({
    prompt: [{ type: 'text', text: 'q' }],
    parent: { session: { meta: { cwd: process.cwd() } } },
    signal: new AbortController().signal,
  })
  await withTimeout(handle.result, 5000, 'subagent')
  await handle.dispose()
  assert.equal(typeof seen.spawnClaudeCodeProcess, 'function')
  assert.equal(seen.env.CLAUDE_CODE_ENTRYPOINT, CLAUDE_ENTRYPOINT)
})
