// Mid-turn steering. The Claude CLI runs its whole tool loop inside ONE
// llm/stream call, so DSH's own step boundary (where it claims inbox.nextStep)
// never comes until the turn is over. Instead, forward steers into the CLI's
// open input at priority 'next', which the CLI folds into the running turn
// after the current tool call.
//
// The durable surface cannot take a steer while one or more tool calls are
// still open: the user message would land between the driver's paired
// assistant/message (tool-call) and its tool/result, and OpenAI-compatible
// routes reject that history. So while a pair is open the steer stays in the
// inbox (the UI keeps painting it as a pending steering row) and is claimed +
// recorded the moment the pair closes.

import { readSessionEvents } from './session-log.js'

const asSegment = (block) => (block?.type === 'image' ? { image: block } : block?.type === 'text' ? block.text : '')

/**
 * Assistant tool-calls in the derived history that no `tool/result` closes yet.
 * A user message appended inside such a pair leaves a bare `tool` wire message
 * with no preceding `tool_calls`, and OpenAI-compatible routes reject the whole
 * history (400) — the same breakage card pairing fixed for model switches, here
 * reachable whenever a steer lands mid tool-call.
 * @param {object} session - DSH session whose committed event log is scanned.
 * @returns {number} unmatched assistant tool-calls, in log order.
 */
export function openToolCalls(session) {
  let open = 0
  for (const event of readSessionEvents(session)) {
    if (event?.type === 'turn/start') open = 0
    else if (event?.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) if (block?.type === 'tool-call') open += 1
    } else if (event?.type === 'tool/result') open = Math.max(0, open - 1)
  }
  return open
}

export function attachSteering(ctx, { push, active, toContent }) {
  const agent = ctx?.get?.('agents')?.currentInitiator?.()
  if (typeof push !== 'function' || typeof ctx?.on !== 'function' || typeof agent?.inbox?.remove !== 'function') return () => {}
  const session = agent.session
  // Steers filed while a tool call is open stay in the inbox until it closes.
  const pending = new Map()
  let watching = false
  let flushing = false
  let stopWatching = () => {}

  const forward = (message) => {
    Promise.resolve(toContent((message.content ?? []).map(asSegment))).then(
      (content) => push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority: 'next' }),
      (error) => ctx.logger?.warn?.('claude-driver: could not forward a steering message', error),
    )
  }

  const record = (message) => {
    // The queue row may have been edited while the tool ran: record the live one.
    const live = agent.inbox.nextStep.find((item) => item.id === message.id)
    if (live === undefined) return
    if (!agent.inbox.remove(live.id)) return
    try {
      session.append('user/message', live, { surfaceOp: 'append' })
    } catch (error) {
      ctx.logger?.warn?.('claude-driver: could not record a steering message', error)
      if (typeof agent.inbox.append === 'function') agent.inbox.append('next-step', live)
    }
  }

  const flush = () => {
    if (flushing || pending.size === 0 || openToolCalls(session) > 0) return
    flushing = true
    try {
      stopWatching()
      stopWatching = () => {}
      watching = false
      for (const message of pending.values()) record(message)
      pending.clear()
    } finally {
      flushing = false
    }
  }

  const watch = () => {
    if (watching) return
    watching = true
    const off = ctx.on('session/event', (eventSession) => {
      // The observer runs inside the append that closes the pair, and a session
      // append cannot reenter its own publication: flush after it returns.
      if (eventSession === session) queueMicrotask(flush)
    }, { global: true })
    stopWatching = typeof off === 'function' ? off : () => {}
  }

  const off = ctx.on('agent/inbox/inserted', (payload) => {
    const { message } = payload ?? {}
    if (payload?.agent !== agent || !message || !active()) return
    if (!agent.inbox.nextStep.some((item) => item.id === message.id)) return
    if (pending.has(message.id)) return
    pending.set(message.id, message)
    // The CLI input gets it now; the running tool call is what gates folding.
    forward(message)
    if (openToolCalls(session) === 0) flush()
    else watch()
  })
  return () => {
    off()
    stopWatching()
    stopWatching = () => {}
    watching = false
    // Unclaimed steers are still in the inbox: the loop delivers them at its
    // own step boundary, so an interrupted turn never drops them.
    pending.clear()
  }
}
