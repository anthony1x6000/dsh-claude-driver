// Production DSH Sessions expose their log through seq/eventAt/snapshotEvents
// only (no `events` array). Everything the driver reads from a session must
// work against that shape. Found on a real DSH host: with an `events`-array
// mock every card test passed while real DSH wrote no card at all.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStepPosition, readSessionEvents, streamClaudeChunks } from '../lib/index.js'
import { readDshPermissions } from '../lib/permission-sync.js'
import { realShapedSession } from './support/real-session.mjs'

const open = () => realShapedSession([['turn/start', { turn: 3 }], ['step/start', { turn: 3, step: 2 }]])

test('the real session shape has no events array (guards the helper below)', () => {
  assert.equal(open().events, undefined)
})

test('readSessionEvents reads a real-shaped session, and an array-shaped test double', () => {
  assert.deepEqual(readSessionEvents(open()).map((e) => e.type), ['turn/start', 'step/start'])
  assert.deepEqual(readSessionEvents({ events: [{ type: 'x' }] }).map((e) => e.type), ['x'])
  assert.deepEqual(readSessionEvents(undefined), [])
})

test('openStepPosition finds the open step on a real-shaped session', () => {
  assert.deepEqual(openStepPosition(open()), { turn: 3, step: 2 })
  const s = open(); s.append('step/end', { turn: 3, step: 2 })
  assert.equal(openStepPosition(s), undefined)
})

test('permission state is read from a real-shaped session log', () => {
  const s = realShapedSession([['sandbox/mode', { mode: 'danger-full-access' }], ['approval/policy', { policy: 'never' }]])
  const dsh = readDshPermissions({ get: () => undefined }, s)
  assert.equal(dsh.sandbox, 'danger-full-access')
})

test('built-in tool cards are written on a real-shaped session', async () => {
  const session = open()
  const ctx = { logger: { info() {}, warn() {} }, get: (n) => (n === 'agents' ? { currentInitiator: () => ({ id: 'a', session }) } : undefined) }
  const queryImpl = () => (async function* () {
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }
    yield { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'ok' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  for await (const _ of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }, { resumeChain: false, queryImpl })) void _
  const types = readSessionEvents(session).map((e) => e.type)
  assert.ok(types.includes('tool/call') && types.includes('tool/result'), types.join())
})

test('a built-in card result is a v4 tool-role message that the real session accepts, and the call is opened once', async () => {
  const session = open()
  const ctx = { logger: { info() {}, warn(...a) { warns.push(a.join(' ')) } }, get: (n) => (n === 'agents' ? { currentInitiator: () => ({ id: 'a', session }) } : undefined) }
  const warns = []
  const queryImpl = () => (async function* () {
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }
    yield { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  for await (const _ of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }, { resumeChain: false, queryImpl })) void _
  const events = readSessionEvents(session)
  const result = events.find((e) => e.type === 'tool/result')
  assert.ok(result, `result appended; warnings: ${warns.join(' | ')}`)
  assert.equal(result.data.message.role, 'tool')
  assert.equal(result.data.message.toolCallId, 't1')
  assert.equal(events.filter((e) => e.type === 'tool/call' && e.data.callId === 't1').length, 1)
  assert.ok(!warns.some((w) => /not appended/.test(w)), warns.join(' | '))
})
