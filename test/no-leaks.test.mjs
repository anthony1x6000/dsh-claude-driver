// A finished turn must leave nothing behind that keeps the host process alive
// (the headless runner exits only when the event loop drains).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStallGuard } from '../lib/stall-guard.js'
import { streamClaudeChunks } from '../lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const activeTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

test('the guard leaves no timer behind after a normal end', async () => {
  const before = activeTimers()
  const { guard } = createStallGuard({ pulseMs: 30_000, startupTimeoutMs: 60_000 }, () => {})
  const q = (async function* () { yield { type: 'result' } })()
  for await (const _ of guard(q)) void _
  await sleep(20)
  assert.equal(activeTimers(), before)
})

test('the guard leaves no timer behind when the consumer stops early', async () => {
  const before = activeTimers()
  const { guard } = createStallGuard({ pulseMs: 30_000, startupTimeoutMs: 60_000 }, () => {})
  const q = (async function* () { yield { type: 'a' }; await sleep(5_000); yield { type: 'b' } })()
  for await (const m of guard(q)) { if (m.type === 'a') break }
  await sleep(50)
  assert.equal(activeTimers(), before)
})

test('a whole turn through the run loop leaves no live timers', async () => {
  const before = activeTimers()
  const queryImpl = () => (async function* () {
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's', result: 'hi', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  for await (const _ of streamClaudeChunks({ get: () => undefined, logger: { info() {}, warn() {} } }, { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }, { resumeChain: false, queryImpl, pulseMs: 30_000 })) void _
  await sleep(50)
  assert.equal(activeTimers(), before)
})

test('stopping after the last message closes the underlying query immediately (no prefetched next() blocks return())', async () => {
  let closed = false
  const q = (async function* () {
    try {
      yield { type: 'result', subtype: 'success' }
      await new Promise(() => {}) // an open-input CLI never ends on its own
    } finally {
      closed = true
    }
  })()
  const { guard } = createStallGuard({ pulseMs: 30_000, startupTimeoutMs: 0 }, () => {})
  for await (const m of guard(q)) { if (m.type === 'result') break }
  assert.equal(closed, true, 'return() reached the query')
})
