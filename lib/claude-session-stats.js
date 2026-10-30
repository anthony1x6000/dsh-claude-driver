// Claude Code session totals for the DSH composer stats bar (the /usage block).
// Token counts are cumulative per query chain, so each result replaces them and
// cost is priced from them locally; durations are per query call, so they sum.

import { costFor } from './claude-prices.js'

const num = (n) => (Number.isFinite(n) ? n : 0)

export function createSessionStats() {
  const sessions = new Map()
  const entry = (sessionId) => {
    let e = sessions.get(sessionId)
    if (!e) {
      e = { requests: 0, results: 0, durationMs: 0, durationApiMs: 0, models: [] }
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
      e.models = Object.entries(result.modelUsage ?? {}).map(([model, u]) => {
        const usage = {
          inputTokens: num(u.inputTokens),
          outputTokens: num(u.outputTokens),
          cacheReadTokens: num(u.cacheReadInputTokens),
          cacheWriteTokens: num(u.cacheCreationInputTokens),
          cacheWriteEphemeral1hTokens: num(u.cacheCreationEphemeral1hInputTokens),
        }
        return {
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: costFor(model, usage),
        }
      })
    },

    snapshot(sessionId) {
      const e = sessions.get(sessionId)
      if (!e || e.results === 0) return null
      const inputTokens = e.models.reduce((sum, m) => sum + m.inputTokens, 0)
      const readTokens = e.models.reduce((sum, m) => sum + m.cacheReadTokens, 0)
      const writeTokens = e.models.reduce((sum, m) => sum + m.cacheWriteTokens, 0)
      const promptTokens = inputTokens + readTokens + writeTokens
      const priced = e.models.every((m) => m.costUsd !== null)
      return {
        costUsd: priced ? Math.round(e.models.reduce((sum, m) => sum + m.costUsd, 0) * 1e9) / 1e9 : null,
        durationMs: e.durationMs,
        durationApiMs: e.durationApiMs,
        requests: e.requests,
        cache: { inputTokens, readTokens, writeTokens, hitRate: promptTokens ? readTokens / promptTokens : 0 },
        models: e.models,
      }
    },
  }
}
