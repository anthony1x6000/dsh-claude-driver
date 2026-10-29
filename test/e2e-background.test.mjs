// Real Claude CLI: a background task Claude starts shows up as a DSH job,
// settles with its real output, and a DSH-side kill actually stops the process.
// The Anthropic API is a local double that asks Claude for a background Bash.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { startMockAnthropic } from './support/mock-anthropic.mjs'

const require = createRequire(import.meta.url)
let hasCli = true
try { require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude') } catch { hasCli = false }
const e2e = { skip: !hasCli && 'no claude binary available', timeout: 120000 }

const work = mkdtempSync(join(tmpdir(), 'e2e-bg-'))
const claudeHome = mkdtempSync(join(tmpdir(), 'e2e-bg-home-'))
const saved = {}
const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v } }
let mock

before(async () => {
  mock = await startMockAnthropic((body) => {
    if (!body.tools?.length) return [{ text: 'title' }]
    const convo = JSON.stringify(body.messages ?? [])
    if (convo.includes('tool_result')) return [{ text: 'started it' }]
    const command = /RUN<<(.+?)>>/.exec(convo)?.[1]
    return [{ tool_use: { id: 'toolu_bg1', name: 'Bash', input: { command, description: 'background work', run_in_background: true } } }]
  })
  setEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-e2e', CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
})
after(async () => {
  await mock?.close()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(work, { recursive: true, force: true })
})

function fakeJobs() {
  const records = []
  return {
    records,
    start(spec) {
      const rec = { spec, appended: [], progress: [] }
      const handle = { id: `claude-task-${records.length + 1}`, append: (t) => rec.appended.push(t), updateProgress: (l) => rec.progress.push(l) }
      rec.hooks = spec.run(handle)
      rec.done = rec.hooks.done.then((o) => { rec.outcome = o; return o })
      records.push(rec)
      return handle.id
    },
  }
}

function mount(jobs) {
  const session = { id: 'sess-bg', events: [], header: { cwd: work } }
  const services = {
    agents: { currentInitiator: () => ({ id: 'a1', session }) },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    jobs,
  }
  let handler
  apply({ logger: { info() {}, warn() {} }, on: (e, fn) => { if (e === 'llm/stream') handler = fn }, get: (n) => services[n] }, { cwd: work, resumeChain: false, backgroundTaskTimeoutMs: 60000 })
  return async (command) => {
    const chunks = []
    const messages = [{ role: 'user', content: [{ type: 'text', text: `go RUN<<${command}>>` }] }]
    for await (const c of handler({ provider: 'claude-code', model: 'sonnet', messages }, () => { throw new Error('not claimed') })) chunks.push(c)
    return chunks
  }
}
const waitFor = async (cond, ms, label) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 50)) } }

test('e2e: a Claude background task is mirrored as a DSH job and settles with its output', e2e, async () => {
  const jobs = fakeJobs()
  const chunks = await mount(jobs)('echo bg-output-marker; sleep 1')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(jobs.records.length, 1, 'exactly one DSH job for the one background task')
  const [rec] = jobs.records
  assert.equal(rec.spec.kind, 'claude-task')
  assert.equal(rec.spec.owner, 'sess-bg')
  assert.match(rec.spec.label, /background work|echo bg-output-marker/)
  const outcome = await Promise.race([rec.done, new Promise((_, rej) => setTimeout(() => rej(new Error('job never settled')), 5000))])
  assert.equal(outcome.status, 'completed')
  assert.match(rec.appended.join(''), /bg-output-marker/, 'the task output reached the job ring')
})

test('e2e: killing the DSH job stops the real background process', e2e, async () => {
  const jobs = fakeJobs()
  const flag = join(work, 'should-not-exist')
  const turn = mount(jobs)(`sleep 30; touch ${flag}`)
  await waitFor(() => jobs.records.length === 1, 60000, 'the job to be registered')
  const started = Date.now()
  jobs.records[0].hooks.cancel('killed from DSH')
  const outcome = await Promise.race([jobs.records[0].done, new Promise((_, rej) => setTimeout(() => rej(new Error('kill never settled the job')), 20000))])
  assert.equal(outcome.status, 'killed')
  const chunks = await turn
  assert.ok(Date.now() - started < 25000, 'the kill ended the turn promptly instead of waiting out the sleep')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(existsSync(flag), false, 'the process was really stopped')
})
