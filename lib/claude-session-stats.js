// Claude Code session totals (the /usage block), persisted in the DSH session log.
//
// Each finished turn appends one plugin record carrying its request count, its
// durations, and the SDK's cumulative per-model tokens. A DSH projection folds
// those records into session totals, so they rebuild from the log after a restart.
// Cost is priced locally from the tokens; the SDK's dollar figures are never read.

import { z } from 'zod'
import { costFor } from './claude-prices.js'

export const USAGE_RECORD = 'plugin:dsh-claude-driver/usage'

const num = (n) => (Number.isFinite(n) ? n : 0)

const emptyState = () => ({ turns: 0, requests: 0, durationMs: 0, durationApiMs: 0, models: [] })

/** The JSON payload persisted for one finished turn. `requests` counts this turn's main-loop calls. */
export function usageRecordFor(result, requests) {
  return {
    requests: num(requests),
    durationMs: num(result.duration_ms),
    durationApiMs: num(result.duration_api_ms),
    models: Object.entries(result.modelUsage ?? {}).map(([model, u]) => ({
      model,
      inputTokens: num(u.inputTokens),
      outputTokens: num(u.outputTokens),
      cacheReadTokens: num(u.cacheReadInputTokens),
      cacheWriteTokens: num(u.cacheCreationInputTokens),
      cacheWriteEphemeral1hTokens: num(u.cacheCreationEphemeral1hInputTokens),
    })),
  }
}

/** Fold one turn record: counts and durations add; the model tokens are cumulative, so the latest replaces. */
export function foldUsage(state = emptyState(), record) {
  return {
    turns: state.turns + 1,
    requests: state.requests + record.requests,
    durationMs: state.durationMs + record.durationMs,
    durationApiMs: state.durationApiMs + record.durationApiMs,
    models: record.models,
  }
}

/** The session view the dock renders, or null before any turn has finished. */
export function summarize(state) {
  if (!state || state.turns === 0) return null
  const sum = (key) => state.models.reduce((total, m) => total + m[key], 0)
  const inputTokens = sum('inputTokens')
  const readTokens = sum('cacheReadTokens')
  const writeTokens = sum('cacheWriteTokens')
  const promptTokens = inputTokens + readTokens + writeTokens
  const models = state.models.map((m) => ({ ...m, costUsd: costFor(m.model, m) }))
  const priced = models.every((m) => m.costUsd !== null)
  return {
    costUsd: priced ? Math.round(models.reduce((total, m) => total + m.costUsd, 0) * 1e9) / 1e9 : null,
    durationMs: state.durationMs,
    durationApiMs: state.durationApiMs,
    requests: state.requests,
    cache: { inputTokens, readTokens, writeTokens, hitRate: promptTokens ? readTokens / promptTokens : 0 },
    models,
  }
}

const modelRow = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  cacheWriteEphemeral1hTokens: z.number(),
})

/** Session projection: the DSH host folds the persisted turn records into this state. */
export const claudeSessionStatsProjection = {
  key: 'claudeSessionStats',
  stateVersion: 1,
  stateSchema: z.object({
    turns: z.number(),
    requests: z.number(),
    durationMs: z.number(),
    durationApiMs: z.number(),
    models: z.array(modelRow),
  }),
  init: emptyState,
  apply: (state, event) => (event.type === USAGE_RECORD && event.data ? foldUsage(state, event.data) : state),
  wire: { viewSchema: z.any(), view: summarize },
}

// Loaded lazily: the DSH session package is provided by the host, and the import
// is the only place this driver touches it.
async function appendThroughDsh(session, type, data) {
  const { appendPluginRecord } = await import('@deepseek-ai/dsh-session')
  appendPluginRecord(session, type, data)
}

/**
 * Append one turn record to the DSH session log. Returns false instead of throwing:
 * a failed write must never fail the turn it describes.
 */
export async function persistUsageRecord(record, { session, append = appendThroughDsh } = {}) {
  if (!session) return false
  try {
    await append(session, USAGE_RECORD, record)
    return true
  } catch {
    return false
  }
}
