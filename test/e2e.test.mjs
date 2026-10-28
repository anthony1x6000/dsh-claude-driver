// End-to-end: the REAL Claude Code CLI (via the real Agent SDK) driven through
// the driver's real llm/stream listener, against a local Anthropic API double.
// No login, no internet. Skipped only when no claude binary is resolvable.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { resolveClaudeExecutable } from '../lib/claude-executable.js'
import { createRequire } from 'node:module'
import { deadPort, startMockAnthropic } from './support/mock-anthropic.mjs'

const require = createRequire(import.meta.url)
let hasCli = false
try {
  require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude')
  hasCli = true
} catch {
  hasCli = Boolean(resolveClaudeExecutable())
}
const e2e = { skip: !hasCli && 'no claude binary available' }

const claudeHome = mkdtempSync(join(tmpdir(), 'e2e-claude-'))
const saved = {}
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

function mount(config, ctxExtra = {}) {
  let handler
  const logs = []
  const ctx = {
    logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    on: (event, fn) => { if (event === 'llm/stream') handler = fn },
    get: () => undefined,
    ...ctxExtra,
  }
  apply(ctx, { resumeChain: false, cwd: tmpdir(), ...config })
  return {
    logs,
    run: async (options) => {
      const chunks = []
      for await (const c of handler({ provider: 'claude-code', model: 'sonnet', messages: [user('hi')], ...options }, () => { throw new Error('not claimed') })) chunks.push(c)
      return chunks
    },
  }
}
const finish = (chunks) => chunks.at(-1)
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HUNG: ${label} > ${ms}ms`)), ms))])

let mock
before(async () => {
  mock = await startMockAnthropic((body) => {
    if (!body.tools?.length) return [{ text: 'title' }] // the CLI's session-title side request
    const convo = JSON.stringify(body.messages ?? [])
    if (convo.includes('tool_result')) return [{ text: `bridge-ok:${/echo:[a-z]+/.exec(convo)?.[0] ?? '?'}` }]
    const bridged = body.tools.find((t) => /fake_plugin_tool$/.test(t.name))
    if (bridged && convo.includes('use the tool')) {
      return [{ tool_use: { id: 'toolu_e2e1', name: bridged.name, input: { text: 'hello' } } }]
    }
    return [{ text: 'mock-pong' }]
  })
  setEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-e2e', CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
})
after(async () => { await mock?.close() })

test('e2e: a plain turn streams text and finishes with stop', e2e, async () => {
  const chunks = await withTimeout(mount({}).run(), 60000, 'plain turn')
  assert.equal(textOf(chunks), 'mock-pong')
  assert.equal(finish(chunks).reason.kind, 'stop')
})

test('e2e: a dead configured proxy fails fast with a clear error (the reported hang)', e2e, async () => {
  const port = await deadPort()
  const started = Date.now()
  const chunks = await withTimeout(mount({ proxy: `http://127.0.0.1:${port}`, apiRetryLimit: 2 }).run(), 60000, 'dead-proxy turn')
  const f = finish(chunks)
  assert.equal(f.type, 'finish')
  assert.equal(f.reason.kind, 'error')
  assert.match(f.reason.failure.message, /reach the Anthropic API|proxy/i)
  assert.ok(Date.now() - started < 45000, 'failed within the deadline, not minutes later')
})

test('e2e: the old default (no proxy configured) works when nothing listens on :7897', e2e, async () => {
  setEnv({ HTTPS_PROXY: undefined, HTTP_PROXY: undefined, ALL_PROXY: undefined })
  const chunks = await withTimeout(mount({}).run(), 60000, 'default-config turn')
  assert.equal(finish(chunks).reason.kind, 'stop')
})

test('e2e: an unreachable API endpoint fails fast instead of hanging', e2e, async () => {
  const port = await deadPort()
  setEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` })
  try {
    const chunks = await withTimeout(mount({ apiRetryLimit: 2 }).run(), 60000, 'unreachable-api turn')
    assert.equal(finish(chunks).reason.kind, 'error')
  } finally {
    setEnv({ ANTHROPIC_BASE_URL: mock.url })
  }
})

test('e2e: a DSH plugin tool is bridged, executed in DSH, and its result reaches Claude', e2e, async () => {
  const executed = []
  const agent = { id: 'a1' }
  const ctxExtra = {
    get(name) {
      if (name === 'tools') return { execute: async (call) => { executed.push(call); return { content: [{ type: 'text', text: `echo:${call.arguments.text}` }], isError: false } } }
      if (name === 'agents') return { currentInitiator: () => agent }
      return undefined
    },
  }
  const tools = [{ name: 'fake_plugin_tool', description: 'Echo.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
  const chunks = await withTimeout(mount({ nativeToolCards: false }, ctxExtra).run({ tools, messages: [user('use the tool')] }), 90000, 'tool bridge turn')
  assert.equal(executed.length, 1, 'DSH tools.execute ran')
  assert.deepEqual(executed[0].arguments, { text: 'hello' })
  assert.match(textOf(chunks), /bridge-ok:echo:hello/)
  assert.equal(finish(chunks).reason.kind, 'stop')
})

test('e2e: the exact failing request (34 DSH tools + long history) completes', e2e, async () => {
  const tools = Array.from({ length: 34 }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}.`, parameters: { type: 'object', properties: { a: { type: 'string' } } } }))
  const messages = Array.from({ length: 60 }, (_, i) => (i % 2 ? { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] } : user(`message ${i}`)))
  messages.push(user('continue'))
  const chunks = await withTimeout(mount({}, { get: () => undefined }).run({ tools, messages }), 90000, 'large request turn')
  assert.equal(finish(chunks).reason.kind, 'stop')
})

test('e2e: caller abort ends the turn promptly', e2e, async () => {
  const slow = await startMockAnthropic(() => [{ text: 'x' }])
  setEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const chunks = await withTimeout(mount({ apiRetryLimit: 50 }).run({ signal: controller.signal }), 30000, 'aborted turn')
    assert.ok(['aborted', 'error'].includes(finish(chunks).reason.kind))
  } finally {
    setEnv({ ANTHROPIC_BASE_URL: mock.url })
    await slow.close()
  }
})
