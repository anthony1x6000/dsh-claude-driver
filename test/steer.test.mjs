// Steering: a message DSH files under inbox.nextStep while the Claude CLI is
// mid-turn must reach the CLI's open input (the whole tool loop is ONE
// llm/stream call, so the loop's own step boundary never comes).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamClaudeChunks } from '../lib/index.js'

const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

function fakeHost() {
  const nextStep = []
  const appended = []
  const listeners = new Map()
  const agent = {
    id: 'a1',
    inbox: {
      get nextStep() {
        return nextStep
      },
      remove(id) {
        const at = nextStep.findIndex((m) => m.id === id)
        if (at < 0) return false
        nextStep.splice(at, 1)
        return true
      },
      append(target, message) {
        if (target !== 'next-step') throw new Error(`unexpected inbox target: ${target}`)
        nextStep.push(message)
      },
    },
    session: {
      // The derived history the provider sees replays these events, so the
      // fake keeps a log for openToolCalls() to scan.
      events: [],
      append(type, data, opts) {
        const event = { type, seq: agent.session.events.length, data, ...(opts === undefined ? {} : { surfaceOp: opts?.surfaceOp }) }
        agent.session.events.push(event)
        appended.push({ type, data, opts })
        return event
      },
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'agents' ? { currentInitiator: () => agent } : undefined),
    on: (event, fn) => {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
  }
  const steer = (message) => {
    nextStep.push(message)
    listeners.get('agent/inbox/inserted')?.({ agent, message })
  }
  // Narrate what the driver's tool cards write: the session publishes every
  // committed event on `session/event`, which the steering observer watches.
  const record = (type, data) => {
    const event = agent.session.append(type, data, { surfaceOp: 'append' })
    listeners.get('session/event')?.(agent.session, event)
    return event
  }
  const card = (callId) =>
    record('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }] } })
  const cardResult = (callId) => record('tool/result', { message: { role: 'tool', toolCallId: callId, content: [] } })
  const userAppends = () => appended.filter((event) => event.type === 'user/message')
  return { ctx, agent, nextStep, appended, listeners, steer, record, card, cardResult, userAppends }
}

// Like the CLI: first message starts the turn; the turn only ends once the
// SECOND (steering) message has been read from the open input.
function steerableQuery(seen) {
  return ({ prompt }) =>
    (async function* () {
      const it = prompt[Symbol.asyncIterator]()
      seen.push((await it.next()).value)
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      const steered = (await it.next()).value
      seen.push(steered)
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
}

const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'start' }] }] }
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG: steer never reached the CLI')), ms))])

test('a mid-turn steer is pushed into the live CLI input and claimed from the inbox', async () => {
  const host = fakeHost()
  const seen = []
  const run = (async () => {
    for await (const _ of streamClaudeChunks(host.ctx, opts, { resumeChain: false, queryImpl: steerableQuery(seen) })) void _
  })()
  await new Promise((r) => setTimeout(r, 20))
  host.steer(userMessage('m1', 'focus on the tests'))
  await withTimeout(run, 2000)

  assert.equal(seen.length, 2)
  assert.deepEqual(seen[1].message.content, [{ type: 'text', text: 'focus on the tests' }])
  assert.equal(seen[1].priority, 'next')
  assert.equal(host.nextStep.length, 0, 'claimed, so the loop does not deliver it a second time')
  assert.equal(host.appended.length, 1)
  assert.equal(host.appended[0].type, 'user/message')
  assert.equal(host.appended[0].data.id, 'm1')
  assert.equal(host.listeners.size, 0, 'listener removed when the run ends')
})

// The CLI keeps the turn open after the steer until the test releases it, so
// the run is still live while the tool card opens and closes.
function gatedQuery(seen, gate) {
  return ({ prompt }) =>
    (async function* () {
      const it = prompt[Symbol.asyncIterator]()
      seen.push((await it.next()).value)
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      seen.push((await it.next()).value)
      await gate
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
}

const openRun = (gate) => {
  let release
  const wait = new Promise((resolve) => {
    release = resolve
  })
  return { wait, release: () => release() }
}

test('a steer filed between a tool card and its result lands after the result', async () => {
  const host = fakeHost()
  const seen = []
  const run = openRun()
  const finished = withTimeout(
    (async () => {
      for await (const _ of streamClaudeChunks(host.ctx, opts, { resumeChain: false, queryImpl: gatedQuery(seen, run.wait) })) void _
    })(),
    2000,
  )
  await new Promise((r) => setTimeout(r, 20))
  host.card('call-1')
  host.steer(userMessage('m3', 'stop and read the log first'))
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(seen.length, 2, 'the CLI input still receives the steer immediately')
  assert.equal(host.userAppends().length, 0, 'no surface append while the tool call has no result')

  host.cardResult('call-1')
  // The observer runs inside the closing append; the flush is a microtask.
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(host.appended.map((event) => event.type), ['assistant/message', 'tool/result', 'user/message'])
  assert.equal(host.userAppends()[0].data.id, 'm3')

  run.release()
  await finished
  assert.equal(host.listeners.size, 0, 'no listener left behind')
})

test('a steer still waiting for its pair at run end goes back to the inbox', async () => {
  const host = fakeHost()
  const seen = []
  const run = openRun()
  const finished = withTimeout(
    (async () => {
      for await (const _ of streamClaudeChunks(host.ctx, opts, { resumeChain: false, queryImpl: gatedQuery(seen, run.wait) })) void _
    })(),
    2000,
  )
  await new Promise((r) => setTimeout(r, 20))
  host.card('call-2')
  host.steer(userMessage('m4', 'never paired'))
  run.release()
  await finished

  assert.equal(host.userAppends().length, 0, 'never appended inside an open pair')
  assert.deepEqual(host.nextStep.map((message) => message.id), ['m4'], 'the loop delivers it at its own step boundary')
})

test('a message that arrives after the run finished stays in the inbox for the loop', async () => {
  const host = fakeHost()
  const seen = []
  const queryImpl = ({ prompt }) =>
    (async function* () {
      seen.push((await prompt[Symbol.asyncIterator]().next()).value)
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  for await (const _ of streamClaudeChunks(host.ctx, opts, { resumeChain: false, queryImpl })) void _
  host.steer(userMessage('m2', 'too late'))
  assert.equal(host.nextStep.length, 1)
  assert.equal(host.appended.length, 0)
})
