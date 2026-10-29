// Real Claude CLI against a local Anthropic API double: Claude runs a genuinely
// slow Bash command. The user must see (a) a native DSH bash card that opens
// when the tool starts and closes with its output, and (b) "still working"
// pulses naming the command while it runs.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { startMockAnthropic } from './support/mock-anthropic.mjs'

const require = createRequire(import.meta.url)
let hasCli = true
try { require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude') } catch { hasCli = false }
const opts = { skip: !hasCli && 'no claude binary', timeout: 120000 }

const saved = {}
const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v } }
let mock
before(async () => {
  mock = await startMockAnthropic((body) => {
    if (!body.tools?.length) return [{ text: 'title' }]
    const convo = JSON.stringify(body.messages)
    if (convo.includes('tool_result')) return [{ text: 'finished' }]
    return [{ tool_use: { id: 'toolu_slow1', name: 'Bash', input: { command: 'sleep 2 && echo SLOW-DONE', description: 'A slow command' } } }]
  })
  setEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-e2e', CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'e2e-live-')), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTPS_PROXY: undefined, HTTP_PROXY: undefined, ALL_PROXY: undefined })
})
after(async () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } await mock?.close() })

function mockSession() {
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }]
  return { id: 's', get events() { return events }, append(type, data, o) { const e = { type, seq: events.length, data, ...(o ?? {}) }; events.push(e); return e } }
}

test('e2e: a slow built-in tool shows a native bash card and live "still working" pulses', opts, async () => {
  const session = mockSession()
  const ctx = { logger: { info() {}, warn() {} }, get: (n) => (n === 'agents' ? { currentInitiator: () => ({ id: 'a', session }) } : undefined) }
  // Production path: apply() merges the shipped defaults, then the llm/stream listener runs.
  let handler
  apply({ ...ctx, on: (event, fn) => { if (event === 'llm/stream') handler = fn } }, { resumeChain: false, cwd: tmpdir(), model: 'sonnet', pulseMs: 500, permissionMode: 'bypassPermissions' })
  const chunks = []
  const timeline = []
  const t0 = Date.now()
  for await (const c of handler({ provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }, () => { throw new Error('not claimed') })) {
    chunks.push(c)
    if (c.type === 'reasoning-delta' && /still working/.test(c.text)) timeline.push(Date.now() - t0)
  }
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const calls = session.events.filter((e) => e.type === 'tool/call')
  const results = session.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 1, 'one native card opened')
  assert.equal(calls[0].data.name, 'bash')
  assert.match(JSON.parse(calls[0].data.arguments).command, /sleep 2/)
  assert.equal(results.length, 1, 'and closed')
  assert.match(results[0].data.message.content[0].text, /SLOW-DONE[\s\S]*\[exit code: 0\]/)
  assert.ok(timeline.length >= 1, `pulses during the slow tool:\n${reasoning}`)
  assert.match(reasoning, /still working.*Bash.*sleep 2/is)
  assert.ok(!reasoning.includes('⚙'), 'no activity-line chatter')
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'finished')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})
