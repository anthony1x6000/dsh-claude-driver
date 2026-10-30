// Claude Code session stats (the /usage block): cost is computed here from the
// cumulative per-model token counts and the local price table, never taken
// from the SDK's own dollar figures. Latest result replaces tokens; durations
// sum per step; requests are counted per main-loop request.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionStats } from '../lib/claude-session-stats.js'

const SONNET = 'claude-sonnet-5-5'
const modelUsage = (over = {}) => ({
  [SONNET]: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 900,
    cacheCreationInputTokens: 200,
    costUSD: 999,
    ...over,
  },
})

test('no snapshot until a session has recorded something', () => {
  const stats = createSessionStats()
  assert.equal(stats.snapshot('dsh-1'), null)
})

test('cost is priced locally from tokens, ignoring the SDK dollar figures', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', { type: 'result', total_cost_usd: 42, modelUsage: modelUsage(), duration_ms: 1, duration_api_ms: 1 })
  // Sonnet 5.5: 100*$2 + 50*$10 + 900*$0.10 + 200*$2.50 (5m write) = $1290 per 1M tokens
  const snap = stats.snapshot('dsh-1')
  assert.equal(snap.costUsd, 0.00129)
  assert.equal(snap.models[0].costUsd, 0.00129)
})

test('the latest result replaces the cumulative tokens, not summed', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', { type: 'result', modelUsage: modelUsage(), duration_ms: 1, duration_api_ms: 1 })
  stats.recordResult('dsh-1', {
    type: 'result',
    modelUsage: { [SONNET]: { inputTokens: 0, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    duration_ms: 1,
    duration_api_ms: 1,
  })
  assert.equal(stats.snapshot('dsh-1').costUsd, 10)
})

test('1-hour cache writes are priced at the 1h rate; unreported lifetimes count as 5m', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', {
    type: 'result',
    modelUsage: {
      [SONNET]: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
        cacheCreationEphemeral1hInputTokens: 500_000,
      },
    },
    duration_ms: 1,
    duration_api_ms: 1,
  })
  // 500k at 5m ($2.50) + 500k at 1h ($4.00) = $3.25
  assert.equal(stats.snapshot('dsh-1').costUsd, 3.25)
})

test('a model without a price leaves cost unknown instead of guessing', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', {
    type: 'result',
    modelUsage: { 'claude-mystery-9': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    duration_ms: 1,
    duration_api_ms: 1,
  })
  const snap = stats.snapshot('dsh-1')
  assert.equal(snap.costUsd, null)
  assert.equal(snap.models[0].costUsd, null)
})

test('durations sum across steps', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', { type: 'result', modelUsage: {}, duration_ms: 1000, duration_api_ms: 800 })
  stats.recordResult('dsh-1', { type: 'result', modelUsage: {}, duration_ms: 500, duration_api_ms: 300 })
  const snap = stats.snapshot('dsh-1')
  assert.equal(snap.durationMs, 1500)
  assert.equal(snap.durationApiMs, 1100)
})

test('requests are counted and cache totals come from the cumulative modelUsage', () => {
  const stats = createSessionStats()
  stats.recordRequest('dsh-1', { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 })
  stats.recordRequest('dsh-1', { input_tokens: 50, cache_read_input_tokens: 150, cache_creation_input_tokens: 0 })
  stats.recordResult('dsh-1', { type: 'result', modelUsage: modelUsage(), duration_ms: 1, duration_api_ms: 1 })
  const snap = stats.snapshot('dsh-1')
  assert.equal(snap.requests, 2)
  assert.equal(snap.cache.readTokens, 900)
  assert.equal(snap.cache.writeTokens, 200)
  assert.equal(snap.cache.hitRate, 0.75)
})

test('sessions are isolated from each other', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', { type: 'result', modelUsage: modelUsage(), duration_ms: 1, duration_api_ms: 1 })
  assert.equal(stats.snapshot('dsh-2'), null)
  assert.ok(stats.snapshot('dsh-1').costUsd > 0)
})

test('a request without usage or session id is ignored rather than throwing', () => {
  const stats = createSessionStats()
  stats.recordRequest(undefined, { input_tokens: 1 })
  stats.recordRequest('dsh-1', undefined)
  assert.equal(stats.snapshot('dsh-1'), null)
})
