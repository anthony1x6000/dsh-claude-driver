// DSH retries a compaction it rejected ("summary is not smaller than the
// shadowed content") without committing anything. The driver must not run a
// second native /compact on an already-compacted Claude session for that retry.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearResumeOnCompaction, getResumeSessions, streamClaudeChunks } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const call = (sessionId) => ({ provider: 'claude-code', model: 'sonnet', sessionId, purpose: 'compaction', messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize' }] }] })
const drain = async (o, s) => { const out = []; for await (const c of streamClaudeChunks(ctx, o, { resumeChain: true, ...s })) out.push(c); return out }
const text = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
function fake(calls) {
  return ({ prompt, options }) => {
    calls.push(prompt)
    return (async function* () {
      const sid = options.resume
      yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 9, post_tokens: 3 }, session_id: sid }
      for (const h of options.hooks?.PostCompact ?? []) for (const fn of h.hooks) await fn({ compact_summary: `summary #${calls.length}` })
      yield { type: 'result', subtype: 'success', result: '', session_id: sid, usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
}

test('a retried compaction before DSH commits reuses the first native summary', async () => {
  getResumeSessions().set('dsh-r', 'claude-r')
  const calls = []
  const first = await drain(call('dsh-r'), { queryImpl: fake(calls) })
  const retry = await drain(call('dsh-r'), { queryImpl: fake(calls) })
  assert.equal(calls.length, 1, 'Claude compacted once')
  assert.equal(text(retry), text(first))
  getResumeSessions().delete('dsh-r')
})

test('a second compaction right after a committed native one reuses Claude\'s summary instead of re-compacting', async () => {
  getResumeSessions().set('dsh-t', 'claude-t')
  const calls = []
  const first = await drain(call('dsh-t'), { queryImpl: fake(calls) })
  assert.equal(clearResumeOnCompaction({ id: 'dsh-t' }, { type: 'compaction/summary', data: {} }), false)
  const second = await drain(call('dsh-t'), { queryImpl: fake(calls) })
  assert.equal(calls.length, 1, 'no user turn ran in between, so Claude is already compacted')
  assert.equal(text(second), text(first))
  getResumeSessions().delete('dsh-t')
})

test('once a user turn runs on the compacted session, the next compaction is native again', async () => {
  getResumeSessions().set('dsh-u', 'claude-u')
  const calls = []
  await drain(call('dsh-u'), { queryImpl: fake(calls) })
  clearResumeOnCompaction({ id: 'dsh-u' }, { type: 'compaction/summary', data: {} })
  const turn = ({ options }) => (async function* () {
    yield { type: 'assistant', session_id: options.resume, message: { content: [{ type: 'text', text: 'hi' }] } }
    yield { type: 'result', subtype: 'success', result: 'hi', session_id: options.resume, usage: { input_tokens: 1, output_tokens: 1 } }
  })()
  await drain({ provider: 'claude-code', model: 'sonnet', sessionId: 'dsh-u', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: [{ type: 'text', text: 'c' }] }] }, { queryImpl: turn })
  await drain(call('dsh-u'), { queryImpl: fake(calls) })
  assert.equal(calls.length, 2)
  getResumeSessions().delete('dsh-u')
})
