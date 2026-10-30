// Claude Code session totals for the DSH composer stats bar (the /usage block).
// Cost and per-model usage are cumulative per query chain, so each result
// replaces them; durations are per query call, so they sum across steps.

const num = (n) => (Number.isFinite(n) ? n : 0)

export function createSessionStats() {
  const sessions = new Map()
  const entry = (sessionId) => {
    let e = sessions.get(sessionId)
    if (!e) {
      e = { requests: 0, results: 0, durationMs: 0, durationApiMs: 0, costUsd: 0, models: [] }
      sessions.set(sessionId, e)
    }
    return e
  }

  return {
    recordRequest(sessionId, usage) {
      if (!sessionId || !usage) return
      entry(sessionId).requests += 1
    },

    recordResult(sessionId, result) {
      if (!sessionId || !result) return
      const e = entry(sessionId)
      e.results += 1
      e.durationMs += num(result.duration_ms)
      e.durationApiMs += num(result.duration_api_ms)
      e.costUsd = num(result.total_cost_usd)
      e.models = Object.entries(result.modelUsage ?? {}).map(([model, u]) => ({
        model,
        inputTokens: num(u.inputTokens),
        outputTokens: num(u.outputTokens),
        cacheReadTokens: num(u.cacheReadInputTokens),
        cacheWriteTokens: num(u.cacheCreationInputTokens),
        costUsd: num(u.costUSD),
      }))
    },

    snapshot(sessionId) {
      const e = sessions.get(sessionId)
      if (!e || e.results === 0) return null
      const inputTokens = e.models.reduce((sum, m) => sum + m.inputTokens, 0)
      const readTokens = e.models.reduce((sum, m) => sum + m.cacheReadTokens, 0)
      const writeTokens = e.models.reduce((sum, m) => sum + m.cacheWriteTokens, 0)
      const promptTokens = inputTokens + readTokens + writeTokens
      return {
        costUsd: e.costUsd,
        durationMs: e.durationMs,
        durationApiMs: e.durationApiMs,
        requests: e.requests,
        cache: { inputTokens, readTokens, writeTokens, hitRate: promptTokens ? readTokens / promptTokens : 0 },
        models: e.models,
      }
    },
  }
}
