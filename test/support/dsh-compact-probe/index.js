// E2E helper plugin for a REAL DSH host (headless profile). Headless calls
// `subagents.waitForChildren(agent)` once the agent is idle and re-checks idle
// when it returns true. The probe wraps it once: on the first idle it runs the
// real `/compact` command through DSH's commands service, prints the outcome as
// `COMPACT_PROBE <json>` on stderr, and returns true so headless waits for it.
export const name = 'dsh-compact-probe'
export const inject = ['subagents', 'commands']

export function apply(ctx) {
  const subagents = ctx.subagents
  const original = subagents.waitForChildren.bind(subagents)
  let done = false
  let summary
  let end
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'compaction/summary') summary = event
    if (event.type === 'compaction/end') end = event
  }, { global: true })
  const preSteps = []
  ctx.on('agent/pre-step', async (payload, next) => {
    const m = ctx.get('tokenMeter')?.measure?.(payload.agent.session)
    const entry = { total: m?.totalTokens, nodes: m?.nodes?.map((n) => n.tokens), header: payload.agent.session.requestHeader?.()?.config }
    preSteps.push(entry)
    if (process.env.COMPACT_PROBE_DIAG) {
      try { entry.direct = (await ctx.get('compaction').compactIfNeeded(payload.agent, 'pressure', payload.signal)) ? 'compacted' : 'null' } catch (e) { entry.directError = String(e?.message ?? e).slice(0, 300) }
    }
    return next()
  })
  subagents.waitForChildren = async (agent) => {
    if (done) return original(agent)
    done = true
    let outcome
    try {
      if (process.env.COMPACT_PROBE_MODE === 'auto') {
        const turns = (process.env.COMPACT_PROBE_TURNS ?? '').split('|||').filter(Boolean)
        for (const text of turns) {
          agent.followup({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: crypto.randomUUID() })
          await agent.whenIdle()
        }
        const meter = ctx.get('tokenMeter')
        const m = meter?.measure?.(agent.session)
        const info = await ctx.get('llm')?.resolveModelInfo?.('claude-code', 'haiku')
        outcome = { preSteps, mode: 'auto', meterTotal: m?.totalTokens, baseline: m?.baseline?.kind, ctxWindow: info?.context?.contextWindow, maxTok: info?.defaultMaxTokens, summary: summary ? { provider: summary.data.provider, text: summary.data.summary?.map((b) => b.text ?? '').join('').slice(0, 400) } : null, endError: end?.data?.error }
        throw Object.assign(new Error('auto-done'), { outcome })
      }
      const execution = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
      outcome = {
        result: execution?.result,
        endError: end?.data?.error,
        summary: summary ? { provider: summary.data.provider, model: summary.data.model, text: summary.data.summary?.map((b) => b.text ?? '').join('') } : null,
      }
    } catch (error) {
      outcome = error?.outcome ?? { thrown: String(error?.stack ?? error) }
    }
    process.stderr.write(`COMPACT_PROBE ${JSON.stringify(outcome)}\n`)
    if (process.env.COMPACT_PROBE_FOLLOWUP) {
      let answer = ''
      const stop = ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'assistant/message') {
          answer = (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        }
      }, { global: true })
      agent.followup({ role: 'user', content: [{ type: 'text', text: process.env.COMPACT_PROBE_FOLLOWUP }], source: { kind: 'user' }, id: crypto.randomUUID() })
      await agent.whenIdle()
      stop()
      process.stderr.write(`COMPACT_PROBE_FOLLOWUP ${JSON.stringify({ answer })}\n`)
    }
    return true
  }
  ctx.on('dispose', () => { subagents.waitForChildren = original })
}
