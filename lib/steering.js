// Mid-turn steering. The Claude CLI runs its whole tool loop inside ONE
// llm/stream call, so DSH's own step boundary (where it claims inbox.nextStep)
// never comes until the turn is over. Instead, claim steers the moment they are
// filed and push them into the CLI's open input at priority 'next', which the
// CLI folds into the running turn after the current tool call.

const asSegment = (block) => (block?.type === 'image' ? { image: block } : block?.type === 'text' ? block.text : '')

export function attachSteering(ctx, { push, active, toContent }) {
  const agent = ctx?.get?.('agents')?.currentInitiator?.()
  if (typeof push !== 'function' || typeof ctx?.on !== 'function' || typeof agent?.inbox?.remove !== 'function') return () => {}
  const off = ctx.on('agent/inbox/inserted', (payload) => {
    const { message } = payload ?? {}
    if (payload?.agent !== agent || !message || !active()) return
    if (!agent.inbox.nextStep.some((pending) => pending.id === message.id)) return
    if (!agent.inbox.remove(message.id)) return
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    Promise.resolve(toContent((message.content ?? []).map(asSegment))).then(
      (content) => push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority: 'next' }),
      (error) => ctx.logger?.warn?.('claude-driver: could not forward a steering message', error),
    )
  })
  return typeof off === 'function' ? off : () => {}
}
