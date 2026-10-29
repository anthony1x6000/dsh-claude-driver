// Claude Code -> DSH: events Claude raises while working must surface in the
// DSH UI instead of vanishing. Fed through the real run loop via queryImpl.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamClaudeChunks } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
async function run(events) {
  const queryImpl = () => (async function* () {
    for (const e of events) yield { session_id: 's', ...e }
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'answer' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's', result: 'answer', usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, opts, { resumeChain: false, queryImpl })) chunks.push(c)
  return { chunks, shown: chunks.filter((c) => c.type === 'reasoning-delta' || c.type === 'text-delta').map((c) => c.text).join('') }
}

test('a permission denial inside Claude is shown, with the tool and reason', async () => {
  const { shown } = await run([{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', decision_reason: 'blocked by policy' }])
  assert.match(shown, /Bash/)
  assert.match(shown, /blocked by policy/)
})

test('a model refusal fallback is shown with both models', async () => {
  const { shown } = await run([{ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', original_model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5-5', request_id: null }])
  assert.match(shown, /claude-opus-5-5/)
  assert.match(shown, /claude-sonnet-5-5/)
})

test('a Claude notification is shown', async () => {
  const { shown } = await run([{ type: 'system', subtype: 'notification', key: 'k', text: 'Usage limit resets at 5pm', priority: 'high' }])
  assert.match(shown, /Usage limit resets at 5pm/)
})

test('Claude compacting on its own is shown', async () => {
  const { shown } = await run([{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 900000, post_tokens: 40000 } }])
  assert.match(shown, /compact/i)
  assert.match(shown, /900000|900k/)
})

test('event notes never count as the model\'s answer', async () => {
  const { chunks } = await run([{ type: 'system', subtype: 'notification', key: 'k', text: 'hi', priority: 'low' }])
  const answer = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(answer.trim(), 'answer')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})
