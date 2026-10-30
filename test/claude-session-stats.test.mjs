// Claude Code session stats (the /usage block): cost and per-model usage come
// from the latest SDK result (cumulative per query chain); durations sum per
// step; requests and prompt-cache traffic accumulate per main-loop request.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionStats } from '../lib/claude-session-stats.js'

const modelUsage = (over = {}) => ({
  'claude-sonnet-5-5': {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 900,
    cacheCreationInputTokens: 200,
    costUSD: 0.12,
    ...over,
  },
})

test('no snapshot until a session has recorded something', () => {
  const stats = createSessionStats()
  assert.equal(stats.snapshot('dsh-1'), null)
})

test('the latest result supplies the cost and per-model rows', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', { type: 'result', total_cost_usd: 0.1, modelUsage: modelUsage(), duration_ms: 1000, duration_api_ms: 800 })
  stats.recordResult('dsh-1', { type: 'result', total_cost_usd: 0.25, modelUsage: modelUsage({ costUSD: 0.25 }), duration_ms: 500, duration_api_ms: 300 })
  const snap = stats.snapshot('dsh-1')
  assert.equal(snap.costUsd, 0.25)
  assert.equal(snap.models[0].model, 'claude-sonnet-5-5')
  assert.equal(snap.models[0].costUsd, 0.25)
})

test('durations sum across steps', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', { type: 'result', total_cost_usd: 0, modelUsage: {}, duration_ms: 1000, duration_api_ms: 800 })
  stats.recordResult('dsh-1', { type: 'result', total_cost_usd: 0, modelUsage: {}, duration_ms: 500, duration_api_ms: 300 })
  const snap = stats.snapshot('dsh-1')
  assert.equal(snap.durationMs, 1500)
  assert.equal(snap.durationApiMs, 1100)
})

test('requests and prompt cache hit share accumulate over the session', () => {
  const stats = createSessionStats()
  stats.recordRequest('dsh-1', { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 })
  stats.recordRequest('dsh-1', { input_tokens: 50, cache_read_input_tokens: 150, cache_creation_input_tokens: 0 })
  stats.recordResult('dsh-1', { type: 'result', total_cost_usd: 0, modelUsage: modelUsage(), duration_ms: 1, duration_api_ms: 1 })
  const snap = stats.snapshot('dsh-1')
  assert.equal(snap.requests, 2)
  assert.equal(snap.cache.readTokens, 1050)
  assert.equal(snap.cache.hitRate, 0.9)
})

test('sessions are isolated from each other', () => {
  const stats = createSessionStats()
  stats.recordResult('dsh-1', { type: 'result', total_cost_usd: 1, modelUsage: {}, duration_ms: 1, duration_api_ms: 1 })
  assert.equal(stats.snapshot('dsh-2'), null)
  assert.equal(stats.snapshot('dsh-1').costUsd, 1)
})

test('a request without usage or session id is ignored rather than throwing', () => {
  const stats = createSessionStats()
  stats.recordRequest(undefined, { input_tokens: 1 })
  stats.recordRequest('dsh-1', undefined)
  assert.equal(stats.snapshot('dsh-1'), null)
})
