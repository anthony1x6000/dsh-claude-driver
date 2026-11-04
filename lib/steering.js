// Mid-turn steering. The Claude CLI runs its whole tool loop inside ONE
// llm/stream call, so DSH's own step boundary (where it claims inbox.nextStep)
// never comes until the turn is over. Instead, claim steers the moment they are
// filed and push them into the CLI's open input at priority 'next', which the
// CLI folds into the running turn after the current tool call.

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
  // Steers filed while a tool call is open wait for its result: the CLI input
  // still gets them at once, the durable surface only where pairing stays legal.
  const deferred = []
  let stopWatching = () => {}
  const append = (message) => session.append('user/message', message, { surfaceOp: 'append' })
  const flush = () => {
    if (deferred.length === 0 || openToolCalls(session) > 0) return
    stopWatching()
    stopWatching = () => {}
    for (const message of deferred.splice(0)) {
      try {
        append(message)
      } catch (error) {
        ctx.logger?.warn?.('claude-driver: could not record a steering message', error)
        if (typeof agent.inbox.append === 'function') agent.inbox.append('next-step', message)
      }
    }
  }
  const record = (message) => {
    if (openToolCalls(session) === 0) {
      append(message)
      return
    }
    deferred.push(message)
    if (deferred.length > 1) return
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
    if (!agent.inbox.nextStep.some((pending) => pending.id === message.id)) return
    if (!agent.inbox.remove(message.id)) return
    record(message)
    Promise.resolve(toContent((message.content ?? []).map(asSegment))).then(
      (content) => push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority: 'next' }),
      (error) => ctx.logger?.warn?.('claude-driver: could not forward a steering message', error),
    )
  })
  return () => {
    off()
    stopWatching()
    stopWatching = () => {}
    // A steer whose tool call never closes keeps its next-step slot instead of
    // landing inside the pair: the loop appends it after its recovery results.
    for (const message of deferred.splice(0)) {
      if (typeof agent.inbox.append === 'function') agent.inbox.append('next-step', message)
    }
  }
}
