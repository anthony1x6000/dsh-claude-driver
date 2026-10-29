// Real Claude CLI against a local Anthropic API double: the DSH system prompt
// lands in Claude's system prompt, and a change on a later turn reaches the
// resumed session (DSH re-renders it each step: plan mode, skills, ...).
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { getResumeSessions, streamClaudeChunks } from '../lib/index.js'
import { startMockAnthropic } from './support/mock-anthropic.mjs'

const require = createRequire(import.meta.url)
let hasCli = true
try { require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude') } catch { hasCli = false }
const opts = { skip: !hasCli && 'no claude binary', timeout: 120000 }

const saved = {}
const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v } }
let mock
before(async () => {
  mock = await startMockAnthropic(() => [{ text: 'ok' }])
  setEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-e2e', CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'e2e-ctx-')), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTPS_PROXY: undefined, HTTP_PROXY: undefined, ALL_PROXY: undefined })
})
after(async () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } await mock?.close() })

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const sys = (text) => ({ role: 'system', content: [{ type: 'text', text }] })
const systemText = (body) => (Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system ?? ''))
const mainRequests = () => mock.requests.filter((b) => b.tools?.length)
async function run(options) {
  for await (const _ of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', ...options }, { resumeChain: true, cwd: tmpdir(), model: 'sonnet' })) void _
}

test('e2e: DSH system prompt reaches Claude\'s system prompt, and later changes reach the resumed session', opts, async () => {
  const sessionId = 'dsh-ctx'
  await run({ sessionId, messages: [sys('DSH-MARKER-ONE: house rules.'), user('hi')] })
  const first = mainRequests().at(-1)
  assert.match(systemText(first), /DSH-MARKER-ONE/, 'DSH prompt is in Claude\'s system prompt')
  assert.ok(!JSON.stringify(first.messages).includes('DSH-MARKER-ONE'), 'not replayed as a user message')
  const claudeId = getResumeSessions().get(sessionId)
  assert.ok(claudeId)

  await run({ sessionId, messages: [sys('DSH-MARKER-TWO: plan mode on.'), user('hi'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('next')] })
  assert.equal(getResumeSessions().get(sessionId), claudeId, 'same Claude session resumed')
  const second = mainRequests().at(-1)
  assert.match(systemText(second), /DSH-MARKER-TWO/, 'updated DSH prompt reached the resumed session')
  assert.ok(!systemText(second).includes('DSH-MARKER-ONE'))
  getResumeSessions().delete(sessionId)
})

test('e2e: Claude\'s duplicates of DSH features are absent from the real tool list; DSH tools are named mcp__dsh-tools__*', opts, async () => {
  const agent = { id: 'a' }
  const toolCtx = { logger: { info() {}, warn() {} }, get: (n) => (n === 'tools' ? { execute: async () => ({ content: [] }) } : n === 'agents' ? { currentInitiator: () => agent } : undefined) }
  const schema = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
  const tools = ['exit_plan_mode', 'web_search', 'web_fetch', 'todo_write', 'schedule_create', 'bash'].map(schema)
  for await (const _ of streamClaudeChunks(toolCtx, { provider: 'claude-code', model: 'sonnet', messages: [user('hi')], tools }, { resumeChain: false, cwd: tmpdir(), model: 'sonnet', nativeToolCards: false })) void _
  const names = mainRequests().at(-1).tools.map((t) => t.name)
  for (const builtin of ['EnterPlanMode', 'ExitPlanMode', 'WebSearch', 'WebFetch', 'TodoWrite', 'CronCreate']) assert.ok(!names.includes(builtin), `${builtin} withheld`)
  assert.ok(names.includes('mcp__dsh-tools__exit_plan_mode'))
  assert.ok(names.includes('mcp__dsh-tools__bash'))
  assert.ok(names.includes('Bash'), 'Claude built-ins without a DSH owner stay')
})
