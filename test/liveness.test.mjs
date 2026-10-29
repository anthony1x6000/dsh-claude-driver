// The user must never wonder whether Claude Code is hanging. While the CLI is
// silent the driver emits a periodic, throttled "still working" pulse naming the
// current activity and elapsed time; the pulse is not progress, so the
// startup/retry watchdogs still fire.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStallGuard, pulseDelay } from '../lib/stall-guard.js'
import { streamClaudeChunks } from '../lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }

test('pulse schedule backs off then caps, so a long wait is not a wall of lines', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map((n) => pulseDelay(10_000, n)), [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000, 60_000])
})

test('guard yields pulse frames while the CLI is silent, then the real message', async () => {
  const { guard } = createStallGuard({ pulseMs: 20, startupTimeoutMs: 0 }, () => {})
  const q = (async function* () { await sleep(130); yield { type: 'result', subtype: 'success' } })()
  const kinds = []
  for await (const m of guard(q)) kinds.push(m.type)
  assert.ok(kinds.filter((k) => k === 'driver_pulse').length >= 2, kinds.join())
  assert.equal(kinds.at(-1), 'result')
})

test('a pulse reports elapsed and idle time', async () => {
  const { guard } = createStallGuard({ pulseMs: 25, startupTimeoutMs: 0 }, () => {})
  const q = (async function* () { await sleep(90); yield { type: 'result' } })()
  const pulses = []
  for await (const m of guard(q)) if (m.type === 'driver_pulse') pulses.push(m)
  assert.ok(pulses[0].idleMs >= 20 && pulses[0].elapsedMs >= 20)
  assert.ok(pulses.at(-1).elapsedMs >= pulses[0].elapsedMs)
})

test('a busy stream gets no pulses', async () => {
  const { guard } = createStallGuard({ pulseMs: 40, startupTimeoutMs: 0 }, () => {})
  const q = (async function* () { for (let i = 0; i < 6; i += 1) { await sleep(10); yield { type: 'stream_event', i } } })()
  const kinds = []
  for await (const m of guard(q)) kinds.push(m.type)
  assert.ok(!kinds.includes('driver_pulse'))
})

test('pulses never reset the startup watchdog: a silent CLI still times out', async () => {
  let stalled = 0
  const { guard, reason } = createStallGuard({ pulseMs: 15, startupTimeoutMs: 120 }, () => { stalled += 1 })
  const q = (async function* () { await sleep(10_000) })()
  const t0 = Date.now()
  const kinds = []
  for await (const m of guard(q)) kinds.push(m.type)
  assert.ok(Date.now() - t0 < 4_000, 'ended after the watchdog fired')
  assert.equal(stalled, 1)
  assert.match(reason(), /startup timeout/)
  assert.ok(kinds.includes('driver_pulse'))
})

test('pulses never reset the retry counter', async () => {
  const { guard, reason } = createStallGuard({ pulseMs: 10, startupTimeoutMs: 0, apiRetryLimit: 3 }, () => {})
  const q = (async function* () {
    for (let n = 1; n <= 4; n += 1) { await sleep(25); yield { type: 'system', subtype: 'api_retry', attempt: n, error_status: null } }
  })()
  for await (const _ of guard(q)) void _
  assert.match(reason(), /cannot reach the Anthropic API/)
})

test('pulseMs:0 disables pulses', async () => {
  const { guard } = createStallGuard({ pulseMs: 0, startupTimeoutMs: 0 }, () => {})
  const q = (async function* () { await sleep(60); yield { type: 'result' } })()
  const kinds = []
  for await (const m of guard(q)) kinds.push(m.type)
  assert.deepEqual(kinds, ['result'])
})

// ---- through the real run loop ----
const slowQuery = (events, gapMs) => () => (async function* () {
  for (const e of events) { if (e.gap) await sleep(e.gap); else yield e }
})()
const answer = [{ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'done' }] } }, { type: 'result', subtype: 'success', session_id: 's', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }]
async function run(events, settings = {}) {
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, opts, { resumeChain: false, pulseMs: 25, startupTimeoutMs: 0, queryImpl: slowQuery(events), ...settings })) chunks.push(c)
  return { chunks, reasoning: chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''), text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') }
}

test('a silent gap shows a still-working pulse in the thinking block, with elapsed time', async () => {
  const { reasoning } = await run([{ gap: 120 }, ...answer])
  assert.match(reasoning, /still working/i)
  assert.match(reasoning, /\d+(\.\d)?s/)
})

test('the pulse names the tool that is running', async () => {
  const { reasoning } = await run([
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { gap: 120 },
    { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ...answer,
  ])
  assert.match(reasoning, /still working.*Bash/is)
  assert.match(reasoning, /npm test/)
})

test('after the tool returns, the pulse goes back to thinking, not the stale tool', async () => {
  const { reasoning } = await run([
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { gap: 120 },
    ...answer,
  ])
  const afterTool = reasoning.slice(reasoning.lastIndexOf('still working'))
  assert.ok(!afterTool.includes('npm test'), afterTool)
  assert.match(afterTool, /thinking|waiting for Claude/i)
})

test('pulses are not the answer and never break the turn', async () => {
  const { text, chunks } = await run([{ gap: 100 }, ...answer])
  assert.equal(text, 'done')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a fast turn has no pulse noise', async () => {
  const { reasoning } = await run(answer, { pulseMs: 5_000 })
  assert.ok(!/still working/i.test(reasoning))
})

test('Claude retrying the API is shown from the second retry on', async () => {
  const { reasoning } = await run([
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 5, error_status: 529, error: 'overloaded', session_id: 's' },
    { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 5, error_status: 529, error: 'overloaded', session_id: 's' },
    ...answer,
  ], { apiHttpRetryLimit: 20 })
  assert.match(reasoning, /retry 2\/10/i)
  assert.match(reasoning, /529/)
})

test('Claude compacting is announced when it starts, not only after', async () => {
  const { reasoning } = await run([{ type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }, ...answer])
  assert.match(reasoning, /compacting/i)
})
