// Claude Code session stats (the /usage block). Each finished turn is persisted
// as a plugin record in the DSH session log; a DSH projection folds those records
// into the session totals, so they rebuild from the log after a restart. Cost is
// priced locally from the cumulative per-model tokens, never the SDK's dollars.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  USAGE_RECORD,
  claudeSessionStatsProjection,
  foldUsage,
  persistUsageRecord,
  summarize,
  usageRecordFor,
} from '../lib/claude-session-stats.js'

const SONNET = 'claude-sonnet-5-5'
const result = (over = {}) => ({
  type: 'result',
  duration_ms: 1000,
  duration_api_ms: 800,
  total_cost_usd: 999,
  modelUsage: {
    [SONNET]: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 200,
      costUSD: 999,
    },
  },
  ...over,
})

test('a turn record carries tokens and durations, never dollar figures', () => {
  const record = usageRecordFor(result(), 3)
  assert.deepEqual(record, {
    requests: 3,
    durationMs: 1000,
    durationApiMs: 800,
    models: [
      {
        model: SONNET,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheWriteTokens: 200,
        cacheWriteEphemeral1hTokens: 0,
      },
    ],
  })
  assert.doesNotThrow(() => JSON.stringify(record))
})

test('folding records sums requests and durations, and replaces the cumulative models', () => {
  let state = foldUsage(undefined, usageRecordFor(result(), 2))
  state = foldUsage(state, usageRecordFor({ ...result(), duration_ms: 500, duration_api_ms: 300, modelUsage: {
    [SONNET]: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } }, 1))
  const view = summarize(state)
  assert.equal(view.requests, 3)
  assert.equal(view.durationMs, 1500)
  assert.equal(view.durationApiMs, 1100)
  assert.equal(view.costUsd, 10)
})

test('cost is priced locally; a model without a price leaves cost unknown', () => {
  const view = summarize(foldUsage(undefined, usageRecordFor(result(), 1)))
  // Sonnet 5.5: 100*$2 + 50*$10 + 900*$0.10 + 200*$2.50 per 1M = $0.00129
  assert.equal(view.costUsd, 0.00129)
  const unknown = summarize(foldUsage(undefined, usageRecordFor({ ...result(), modelUsage: {
    'claude-mystery-9': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  } }, 1)))
  assert.equal(unknown.costUsd, null)
  assert.equal(unknown.models[0].costUsd, null)
})

test('1-hour cache writes are priced at the 1h rate; unreported lifetimes count as 5m', () => {
  const record = usageRecordFor({ ...result(), modelUsage: {
    [SONNET]: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheCreationEphemeral1hInputTokens: 500_000,
    },
  } }, 1)
  // 500k at 5m ($2.50/M) + 500k at 1h ($4.00/M) = $3.25
  assert.equal(summarize(foldUsage(undefined, record)).costUsd, 3.25)
})

test('cache hit share is read / (input + read + write) from the folded models', () => {
  const view = summarize(foldUsage(undefined, usageRecordFor(result(), 2)))
  assert.equal(view.cache.readTokens, 900)
  assert.equal(view.cache.writeTokens, 200)
  assert.equal(view.cache.hitRate, 0.75)
})

test('the projection folds only its own records and exposes the summary as its view', () => {
  const def = claudeSessionStatsProjection
  assert.equal(def.key, 'claudeSessionStats')
  let state = def.init()
  state = def.apply(state, { type: 'assistant/message', data: {} })
  assert.deepEqual(state, def.init())
  state = def.apply(state, { type: USAGE_RECORD, data: usageRecordFor(result(), 1) })
  assert.equal(def.wire.view(state).requests, 1)
})

test('persisting appends the record to the session log and reports success', async () => {
  const appended = []
  const ok = await persistUsageRecord(usageRecordFor(result(), 1), {
    session: { id: 'dsh-1' },
    append: async (session, type, data) => appended.push({ type, data }),
  })
  assert.equal(ok, true)
  assert.equal(appended[0].type, USAGE_RECORD)
})

test('a failed append is reported, never thrown into the turn', async () => {
  const ok = await persistUsageRecord(usageRecordFor(result(), 1), {
    session: { id: 'dsh-1' },
    append: async () => {
      throw new Error('session log closed')
    },
  })
  assert.equal(ok, false)
})

test('no session means nothing is persisted and nothing throws', async () => {
  const ok = await persistUsageRecord(usageRecordFor(result(), 1), { session: undefined, append: async () => assert.fail('no append without a session') })
  assert.equal(ok, false)
})

test('a malformed persisted record never breaks the projection', () => {
  const { apply, init } = claudeSessionStatsProjection
  for (const data of [{}, { requests: 2 }, { models: null }, { models: [null, { model: 'x' }] }, 'junk', 7, []]) {
    const state = apply(init(), { type: USAGE_RECORD, data })
    assert.ok(Array.isArray(state.models), `models stays an array for ${JSON.stringify(data)}`)
    assert.doesNotThrow(() => summarize(state))
    assert.doesNotThrow(() => claudeSessionStatsProjection.stateSchema.parse(state))
  }
})

test('summarize tolerates a state without a model list', () => {
  assert.doesNotThrow(() => summarize({ turns: 1 }))
  assert.doesNotThrow(() => summarize({ turns: 1, models: null }))
})

test('apply recovers from a corrupt prior state', () => {
  const record = usageRecordFor(result(), 1)
  const state = claudeSessionStatsProjection.apply({ turns: 'x' }, { type: USAGE_RECORD, data: record })
  claudeSessionStatsProjection.stateSchema.parse(state)
  assert.equal(state.requests, 1)
})
