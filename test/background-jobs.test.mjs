// Claude Code's own background tasks must be visible in DSH: each one is
// mirrored as a DSH job (job_list / job_output / job_kill and the jobs panel
// see it), settles with the real outcome, and can be stopped from DSH.
// Fake JobRegistry + scripted SDK stream: no CLI, no network.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { streamClaudeChunks } from '../lib/index.js'

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const baseOptions = { provider: 'claude-code', model: 'sonnet', messages: [user('go')] }

// A JobRegistry double honouring the documented start() contract.
function fakeJobs({ failStart } = {}) {
  const records = []
  return {
    records,
    start(spec) {
      if (failStart) throw new Error(failStart)
      const rec = { spec, appended: [], progress: [], outcome: undefined, cancelled: [] }
      const handle = {
        id: `${spec.kind}-${records.length + 1}`,
        append: (text) => rec.appended.push(text),
        updateProgress: (line) => rec.progress.push(line),
      }
      rec.hooks = spec.run(handle)
      rec.id = handle.id
      rec.done = rec.hooks.done.then((outcome) => { rec.outcome = outcome; return outcome })
      records.push(rec)
      return handle.id
    },
  }
}

function harness({ jobs, session = { id: 'sess-1', events: [], header: { cwd: '/tmp' } } } = {}) {
  const warnings = []
  const services = { agents: { currentInitiator: () => ({ id: 'a1', session }) } }
  if (jobs) services.jobs = jobs
  const ctx = { logger: { info() {}, warn: (...a) => warnings.push(a.join(' ')) }, get: (n) => services[n] }
  return { ctx, warnings, session }
}

// Scriptable query: `steps` are SDK messages, numbers (ms delays) or functions
// awaited in-line. Exposes stopTask like the real SDK Query.
function scripted(steps, stops = []) {
  return ({ options }) => {
    const aborted = new Promise((resolve) => options.abortController.signal.addEventListener('abort', () => resolve('aborted'), { once: true }))
    const gen = (async function* () {
      for (const step of steps) {
        if (options.abortController.signal.aborted) return
        if (typeof step === 'number') {
          if ((await Promise.race([new Promise((r) => setTimeout(() => r('done'), step)), aborted])) === 'aborted') return
        } else if (typeof step === 'function') yield* (await step()) ?? []
        else yield step
      }
    })()
    gen.stopTask = async (id) => { stops.push(id) }
    return gen
  }
}

const sys = (subtype, extra) => ({ type: 'system', subtype, session_id: 's1', ...extra })
const live = (...tasks) => sys('background_tasks_changed', { tasks })
const T = (id, description, extra = {}) => ({ task_id: id, task_type: 'local_bash', description, ...extra })
const notif = (id, status, summary = '', extra = {}) => sys('task_notification', { task_id: id, status, summary, output_file: '', ...extra })
const assistant = (text) => ({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } })
const result = (text = 'ok') => ({ type: 'result', subtype: 'success', session_id: 's1', result: text, usage: { input_tokens: 1, output_tokens: 1 } })

async function run(h, steps, settings = {}, stops) {
  const chunks = []
  const merged = { resumeChain: false, startupTimeoutMs: 0, queryImpl: scripted(steps, stops), ...settings }
  for await (const c of streamClaudeChunks(h.ctx, baseOptions, merged)) chunks.push(c)
  return chunks
}
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

test('a Claude background task becomes a DSH job owned by the session', async () => {
  const jobs = fakeJobs()
  const h = harness({ jobs })
  await run(h, [live(T('t1', 'npm run build')), assistant('started'), result(), notif('t1', 'completed', 'built'), live()])
  assert.equal(jobs.records.length, 1)
  const [rec] = jobs.records
  assert.equal(rec.spec.kind, 'claude-task')
  assert.equal(rec.spec.label, 'npm run build')
  assert.equal(rec.spec.owner, 'sess-1')
  assert.match(rec.appended.join(''), /npm run build/)
})

test('a completed task settles the job as completed, with its summary as the result', async () => {
  const jobs = fakeJobs()
  await run(harness({ jobs }), [live(T('t1', 'tests')), assistant('x'), result(), notif('t1', 'completed', 'all 12 passed\nmore detail'), live()])
  const outcome = await jobs.records[0].done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /all 12 passed/)
  assert.match(jobs.records[0].appended.join(''), /all 12 passed/)
})

test('failed and stopped tasks settle as failed and killed', async () => {
  const jobs = fakeJobs()
  await run(harness({ jobs }), [live(T('a', 'one'), T('b', 'two')), assistant('x'), result(), notif('a', 'failed', 'exit 3'), notif('b', 'stopped', 'stopped by user'), live()])
  const byLabel = Object.fromEntries(await Promise.all(jobs.records.map(async (r) => [r.spec.label, (await r.done).status])))
  assert.deepEqual(byLabel, { one: 'failed', two: 'killed' })
  assert.match((await jobs.records[0].done).detail, /exit 3|failed/)
})

test('ambient housekeeping tasks are never mirrored', async () => {
  const jobs = fakeJobs()
  await run(harness({ jobs }), [live(T('amb', 'watcher', { ambient: true })), assistant('x'), result(), live()])
  assert.equal(jobs.records.length, 0)
})

test('the same task reported again is registered once, and a settled task is never reopened', async () => {
  const jobs = fakeJobs()
  await run(harness({ jobs }), [live(T('t1', 'x')), live(T('t1', 'x')), assistant('x'), result(), notif('t1', 'completed'), live(T('t1', 'x')), live()])
  assert.equal(jobs.records.length, 1)
})

test('progress frames update the job progress line', async () => {
  const jobs = fakeJobs()
  await run(harness({ jobs }), [live(T('t1', 'x')), sys('task_progress', { task_id: 't1', description: 'x', summary: 'compiling 3/10', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }), assistant('x'), result(), notif('t1', 'completed'), live()])
  assert.ok(jobs.records[0].progress.some((l) => /compiling 3\/10/.test(l)))
})

test('stopping the job from DSH stops the Claude task', async () => {
  const jobs = fakeJobs()
  const stops = []
  let release
  const gate = new Promise((r) => { release = r })
  const steps = [live(T('t1', 'long job')), assistant('x'), result(), async () => { jobs.records[0].hooks.cancel('user asked'); await gate; return [notif('t1', 'stopped', 'stopped'), live()] }]
  const done = run(harness({ jobs }), steps, {}, stops)
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(stops, ['t1'], 'cancel reached query.stopTask with the Claude task id')
  release()
  await done
  assert.equal((await jobs.records[0].done).status, 'killed')
})

test('a task that silently leaves the live set settles as completed', async () => {
  const jobs = fakeJobs()
  await run(harness({ jobs }), [live(T('t1', 'x')), assistant('x'), result(), live()])
  assert.equal((await jobs.records[0].done).status, 'completed')
})

test('a task still running when the run is torn down settles as killed, never left dangling', async () => {
  const jobs = fakeJobs()
  const chunks = await run(harness({ jobs }), [live(T('t1', 'forever')), assistant('x'), result(), 60_000], { backgroundTaskTimeoutMs: 150 })
  const outcome = await Promise.race([jobs.records[0].done, new Promise((_, rej) => setTimeout(() => rej(new Error('job left dangling')), 3000))])
  assert.equal(outcome.status, 'killed')
  assert.match(outcome.detail, /ended|torn down|timed out|stopped/i)
  assert.match(textOf(chunks), /forever/, 'the existing text narration is still emitted')
})

test('the output file written by the task is attached to the job at settlement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bgjob-'))
  try {
    const file = join(dir, 'out.txt')
    writeFileSync(file, 'line one\nline two\n')
    const jobs = fakeJobs()
    await run(harness({ jobs }), [live(T('t1', 'x')), assistant('x'), result(), notif('t1', 'completed', 'ok', { output_file: file }), live()])
    assert.match(jobs.records[0].appended.join(''), /line two/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without a jobs service the driver behaves exactly as before', async () => {
  const chunks = await run(harness(), [live(T('t1', 'x')), assistant('answer'), result('answer'), notif('t1', 'completed', 'done'), live()])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.match(textOf(chunks), /answer/)
})

test('a jobs.start failure is contained: warned once, turn unaffected', async () => {
  const h = harness({ jobs: fakeJobs({ failStart: 'owner not served' }) })
  const chunks = await run(h, [live(T('a', 'one'), T('b', 'two')), assistant('answer'), result('answer'), notif('a', 'completed'), notif('b', 'completed'), live()])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(h.warnings.filter((w) => /owner not served/.test(w)).length, 1)
})

test('mirrorBackgroundJobs:false disables the mirror', async () => {
  const jobs = fakeJobs()
  await run(harness({ jobs }), [live(T('t1', 'x')), assistant('x'), result(), notif('t1', 'completed'), live()], { mirrorBackgroundJobs: false })
  assert.equal(jobs.records.length, 0)
})
