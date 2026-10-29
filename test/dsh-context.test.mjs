// What DSH puts in a request must reach Claude Code with its meaning intact.
// Shapes are copied from a real captured DSH request (system message first,
// then user messages, then the runtime-context user message).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSdkOptions, planPrompt, renderPromptSegments, segmentsToText } from '../lib/index.js'

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const SYSTEM = 'You are an AI agent powered by DeepSeek Harness.\n\nCheck the [exit code: N] marker on every bash result.'
const sys = { role: 'system', content: [{ type: 'text', text: SYSTEM }], source: { kind: 'system-prompt' } }
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const file = { type: 'file', attachment: { attachmentId: 'sha256:abcdef0123456789', name: 'report.pdf', bytes: 2048, mediaType: 'application/pdf' } }

test('the DSH system prompt goes to Claude Code as its system prompt, appended to Claude\'s own', () => {
  const options = { provider: 'claude-code', model: 'sonnet', messages: [sys, user('hi')] }
  const sdk = buildSdkOptions(ctx, options, { model: 'sonnet', effort: 'medium' }, { controller: new AbortController(), model: 'sonnet' })
  assert.deepEqual(sdk.systemPrompt, { type: 'preset', preset: 'claude_code', append: SYSTEM, snapshot: false })
})

test('the system message is not replayed as a user turn', () => {
  const text = segmentsToText(renderPromptSegments({ messages: [sys, user('hi')] }))
  assert.ok(!text.includes('<User>\nYou are an AI agent powered by DeepSeek Harness'), 'system prompt must not be labelled as the user')
  assert.ok(!text.includes(SYSTEM))
  assert.match(text, /<User>\nhi\n<\/User>/)
})

test('options.system is honoured as well', () => {
  const sdk = buildSdkOptions(ctx, { provider: 'claude-code', model: 'sonnet', system: 'Be terse.', messages: [user('hi')] }, { model: 'sonnet' }, { controller: new AbortController(), model: 'sonnet' })
  assert.equal(sdk.systemPrompt.append, 'Be terse.')
})

test('no DSH system prompt keeps Claude Code\'s default untouched', () => {
  const sdk = buildSdkOptions(ctx, { provider: 'claude-code', model: 'sonnet', messages: [user('hi')] }, { model: 'sonnet' }, { controller: new AbortController(), model: 'sonnet' })
  assert.equal(sdk.systemPrompt, undefined)
})

test('a DSH file attachment reaches Claude as its readable path handle', () => {
  const text = segmentsToText(renderPromptSegments({ messages: [{ role: 'user', content: [{ type: 'text', text: 'summarise this' }, file] }] }))
  assert.match(text, /report\.pdf/)
})

test('developer messages (DSH tool updates/reminders) reach Claude, labelled as harness context', () => {
  const dev = { role: 'developer', content: [{ type: 'text', text: 'Tool web_search is now available.' }] }
  const text = segmentsToText(renderPromptSegments({ messages: [user('a'), dev] }))
  assert.match(text, /Tool web_search is now available\./)
  assert.ok(!/<User>\nTool web_search/.test(text))
})

test('tool-role messages are rendered as tool results, not as the user', () => {
  const toolMsg = { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'exit 0' }] }
  const text = segmentsToText(renderPromptSegments({ messages: [user('a'), { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] }, toolMsg] }))
  assert.match(text, /\[tool-result c1\]: exit 0/)
})

test('on resume the tail still carries a later system-prompt change', () => {
  const sessions = new Map([['s1', 'claude-1']])
  const plan = planPrompt({ sessionId: 's1', messages: [sys, user('a'), { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, user('c')] }, { resumeChain: true }, sessions)
  assert.equal(plan.mode, 'resume')
  assert.ok(!plan.prompt.includes(SYSTEM), 'resume prompt carries only the new user tail')
})

test('the system prompt is re-sent every request so later DSH changes (plan mode, skills) reach a resumed Claude session', () => {
  const sdk = buildSdkOptions(ctx, { provider: 'claude-code', model: 'sonnet', messages: [sys, user('hi')] }, { model: 'sonnet' }, { controller: new AbortController(), model: 'sonnet', resumeId: 'claude-1' })
  assert.equal(sdk.systemPrompt.snapshot, false)
  assert.equal(sdk.resume, 'claude-1')
})

test('a prewarmed process started under a different DSH system prompt is not reused', async () => {
  const { systemPromptKey } = await import('../lib/index.js')
  assert.notEqual(systemPromptKey({ messages: [sys] }), systemPromptKey({ messages: [{ ...sys, content: [{ type: 'text', text: SYSTEM + '\nPlan mode on.' }] }] }))
  assert.equal(systemPromptKey({ messages: [sys] }), systemPromptKey({ messages: [sys, user('x')] }))
})

test('a DSH file attachment resolves to the same readable path DSH gives every other model', async () => {
  const { renderPromptSegmentsFor } = await import('../lib/index.js')
  const fileCtx = {
    get: (n) => n === 'attachments' ? { fileHostPath: (ref) => `/host/att/${ref.attachmentId.slice(7, 15)}` }
      : n === 'fs' ? { processPathFromHostPath: (p) => p.replace('/host', '/proc') } : undefined,
  }
  const text = segmentsToText(renderPromptSegmentsFor(fileCtx, { messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }, file] }] }))
  assert.match(text, /report\.pdf/)
  assert.match(text, /\/proc\/att\/abcdef01/)
  assert.match(text, /Read that path with your file tools/)
})

test('DSH session-title requests run as a one-shot, never on the user\'s Claude session', async () => {
  const { getResumeSessions, streamClaudeChunks } = await import('../lib/index.js')
  getResumeSessions().set('dsh-title', 'claude-user')
  let seen
  const queryImpl = ({ options }) => { seen = options; return (async function* () {
    yield { type: 'assistant', session_id: 'claude-title', message: { content: [{ type: 'text', text: 'A title' }] } }
    yield { type: 'result', subtype: 'success', session_id: 'claude-title', result: 'A title', usage: { input_tokens: 1, output_tokens: 1 } }
  })() }
  for await (const _ of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'haiku', sessionId: 'dsh-title', purpose: 'session-title', messages: [user('name this')] }, { resumeChain: true, queryImpl })) void _
  assert.equal(seen.resume, undefined)
  assert.equal(getResumeSessions().get('dsh-title'), 'claude-user', 'user chain untouched')
  getResumeSessions().delete('dsh-title')
})

test('a turn with a DSH file block gives Claude the readable path (through the real stream path)', async () => {
  const { streamClaudeChunks } = await import('../lib/index.js')
  const fileCtx = {
    logger: { info() {}, warn() {} },
    get: (n) => n === 'attachments' ? { fileHostPath: () => '/host/att/abc' } : n === 'fs' ? { processPathFromHostPath: (p) => p.replace('/host', '/proc') } : undefined,
  }
  let prompt
  const queryImpl = (args) => { prompt = args.prompt; return (async function* () {
    yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
  })() }
  for await (const _ of streamClaudeChunks(fileCtx, { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }, file] }] }, { resumeChain: false, queryImpl, waitForBackgroundTasks: false })) void _
  const text = typeof prompt === 'string' ? prompt : JSON.stringify((await prompt[Symbol.asyncIterator]().next()).value)
  assert.match(text, /\/proc\/att\/abc/)
})
