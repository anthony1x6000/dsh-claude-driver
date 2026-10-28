// Regression: "press enter, thinking forever". Root cause was a baked-in default
// proxy (http://127.0.0.1:7897) that nothing listens on: the Claude CLI retries
// the API for minutes while emitting only `api_retry` frames, so DSH never gets
// a chunk and never gets a finish. A turn must ALWAYS end in finish.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSdkOptions, streamClaudeChunks, apply } from '../lib/index.js'
import { createClaudeCodeProvider } from '../lib/subagent-provider.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
const sdkOptionsFor = (settings) => {
  const controller = new AbortController()
  return buildSdkOptions(ctx, opts, settings, { controller, model: 'sonnet' })
}
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HUNG: ${label} did not finish in ${ms}ms`)), ms))])

async function drain(settings) {
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, opts, { resumeChain: false, ...settings })) chunks.push(c)
  return chunks
}
// A fake SDK query that behaves like the CLI behind a dead proxy: one init frame,
// then api_retry frames forever, honouring the abort controller.
const deadNetworkQuery = ({ options }) =>
  (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' }
    for (let attempt = 1; ; attempt += 1) {
      if (options.abortController.signal.aborted) return
      yield { type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 5, error_status: null, error: 'unknown', session_id: 's1' }
      await new Promise((r) => setTimeout(r, 5))
    }
  })()
// Behaves like a CLI that never prints anything at all.
const silentQuery = ({ options }) =>
  (async function* () {
    await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true }))
  })()

// Drive the REAL production path: apply() merges DEFAULTS, then the llm/stream
// listener runs a turn. Returns the env the Claude process would receive.
async function envSeenThroughApply(config) {
  let handler
  let seen
  const queryImpl = ({ options }) => {
    seen = options.env
    return (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
  apply({ logger: { info() {}, warn() {} }, on: (e, fn) => { if (e === 'llm/stream') handler = fn }, get: () => undefined }, { resumeChain: false, queryImpl, ...config })
  for await (const _ of handler(opts, () => { throw new Error('next') })) void _
  return seen
}

test('apply() defaults bake in no proxy: the Claude process env is left as-is', async () => {
  const before = process.env.HTTPS_PROXY
  delete process.env.HTTPS_PROXY
  try {
    const env = await envSeenThroughApply({})
    assert.equal(env.HTTPS_PROXY, undefined)
    assert.equal(env.HTTP_PROXY, undefined)
    assert.equal(env.ALL_PROXY, undefined)
  } finally {
    if (before !== undefined) process.env.HTTPS_PROXY = before
  }
})

test('an explicitly configured proxy is still honoured', () => {
  const env = sdkOptionsFor({ model: 'sonnet', proxy: 'http://10.0.0.1:3128' }).env
  assert.equal(env.HTTPS_PROXY, 'http://10.0.0.1:3128')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1')
})

test('subagent provider has no baked-in proxy either', async () => {
  let seenEnv
  const queryImpl = ({ options }) => {
    seenEnv = options.env
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's' }
    })()
  }
  const before = process.env.HTTPS_PROXY
  delete process.env.HTTPS_PROXY
  try {
    const handle = await createClaudeCodeProvider({ queryImpl }).start({ prompt: [{ type: 'text', text: 'q' }], parent: { session: { meta: { cwd: '/tmp' } } }, signal: new AbortController().signal })
    await withTimeout(handle.result, 5000, 'subagent')
    await handle.dispose()
  } finally {
    if (before !== undefined) process.env.HTTPS_PROXY = before
  }
  assert.ok(seenEnv, 'subagent provider ran its query')
  assert.equal(seenEnv.HTTPS_PROXY, undefined)
})

test('a dead network (endless api_retry) ends in a finish error, not a hang', async () => {
  const chunks = await withTimeout(drain({ queryImpl: deadNetworkQuery }), 8000, 'dead-network turn')
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT')
  assert.match(finish.reason.failure.message, /reach|network|proxy/i)
})

test('a CLI that never speaks is cut off by the startup deadline', async () => {
  const chunks = await withTimeout(drain({ queryImpl: silentQuery, startupTimeoutMs: 150 }), 8000, 'silent turn')
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TIMEOUT')
  assert.match(finish.reason.failure.message, /startup timeout/i)
})

test('a healthy turn is not disturbed by the watchdogs', async () => {
  const ok = () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' }
    yield { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1, error: 'unknown', session_id: 's1' }
    yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'pong' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's1', result: 'pong', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  const chunks = await withTimeout(drain({ queryImpl: ok, startupTimeoutMs: 150 }), 5000, 'healthy turn')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a slow-but-alive first token (after init) is not killed by the startup deadline', async () => {
  const slow = () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' }
    await new Promise((r) => setTimeout(r, 400))
    yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'late' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's1', result: 'late', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  const chunks = await withTimeout(drain({ queryImpl: slow, startupTimeoutMs: 150 }), 5000, 'slow turn')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a subagent on a dead network settles with an error instead of hanging', async () => {
  const handle = await createClaudeCodeProvider({ queryImpl: deadNetworkQuery }).start({
    prompt: [{ type: 'text', text: 'q' }],
    parent: { session: { meta: { cwd: '/tmp' } } },
    signal: new AbortController().signal,
  })
  const result = await withTimeout(handle.result, 8000, 'dead-network subagent')
  assert.equal(result.stopReason, 'error')
  assert.match(result.detail, /reach|network|proxy/i)
  await handle.dispose()
})
