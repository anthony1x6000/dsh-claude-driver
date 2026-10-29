// The picker must show what Claude Code itself reports (e.g. "Sonnet 5.5"),
// follow new releases without a plugin change, and never get stuck on a stale
// or failed discovery. Fixture = real supportedModels() output (SDK 0.3.312).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClaudeCodeAdapter, modelInfoToEntry, resolveModelList } from '../lib/model-catalog.js'

const eff5 = ['low', 'medium', 'high', 'xhigh', 'max']
const REAL = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: eff5 },
  { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: eff5 },
  { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: eff5 },
  { value: 'fable', displayName: 'Fable 5.1', resolvedModel: 'claude-fable-5-1', supportedEffortLevels: eff5 },
  { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: eff5 },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', resolvedModel: 'claude-sonnet-5', supportedEffortLevels: eff5 },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', resolvedModel: 'claude-opus-4-8', supportedEffortLevels: eff5 },
]
const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]))

test('aliases are labelled with the version Claude Code reports', async () => {
  const list = byId(await resolveModelList({}, async () => REAL))
  assert.equal(list.sonnet.name, 'Sonnet 5.5')
  assert.equal(list.opus.name, 'Opus 5.5')
  assert.equal(list.haiku.name, 'Haiku 5.5')
  assert.equal(list.fable.name, 'Fable 5.1')
})

test('aliases come first, and the redundant "default" entry is hidden', async () => {
  const list = await resolveModelList({}, async () => REAL)
  assert.deepEqual(list.slice(0, 4).map((m) => m.id), ['fable', 'sonnet', 'opus', 'haiku'])
  assert.ok(!list.some((m) => m.id === 'default'))
  assert.ok(list.some((m) => m.id === 'claude-opus-4-8'), 'older pinned versions stay selectable')
})

test('context windows follow the model generation, not a stale hard-coded table', async () => {
  const list = byId(await resolveModelList({}, async () => REAL))
  for (const id of ['fable', 'sonnet', 'opus', 'haiku']) assert.equal(list[id].contextWindow, 1_000_000, id)
  assert.equal(list['claude-haiku-4-5-20251001'].contextWindow, 200_000)
})

test('a brand-new release appears with no plugin change', async () => {
  const next = [{ value: 'sonnet', displayName: 'Sonnet 6', resolvedModel: 'claude-sonnet-6', supportedEffortLevels: eff5 }, { value: 'claude-opus-6', displayName: 'Opus 6', resolvedModel: 'claude-opus-6' }]
  const list = byId(await resolveModelList({}, async () => next))
  assert.equal(list.sonnet.name, 'Sonnet 6')
  assert.equal(list['claude-opus-6'].name, 'Opus 6')
  assert.equal(list['claude-opus-6'].contextWindow, 1_000_000)
})

test('user-configured names and windows still win over discovery', async () => {
  const list = byId(await resolveModelList({ models: [{ id: 'sonnet', name: 'My Sonnet', contextWindow: 123_000 }] }, async () => REAL))
  assert.equal(list.sonnet.name, 'My Sonnet')
  assert.equal(list.sonnet.contextWindow, 123_000)
})

test('discovery failure falls back to a usable alias list', async () => {
  const list = await resolveModelList({}, async () => { throw new Error('boom') })
  assert.deepEqual(list.map((m) => m.id), ['fable', 'sonnet', 'opus', 'haiku'])
  assert.ok(list.every((m) => m.contextWindow > 0))
})

test('modelInfoToEntry keeps SDK effort levels', () => {
  assert.deepEqual(modelInfoToEntry(REAL[2]).efforts, eff5)
})

test('a failed discovery is retried instead of cached forever', async () => {
  let calls = 0
  const discover = async () => { calls += 1; if (calls === 1) throw new Error('cli not ready'); return REAL }
  const adapter = createClaudeCodeAdapter({ provider: 'claude-code', effort: 'medium', modelRetryMs: 0 }, discover)
  const first = await adapter.listModels('claude-code')
  assert.equal(first.find((m) => m.id === 'sonnet').name, 'sonnet')
  const second = await adapter.listModels('claude-code')
  assert.equal(second.find((m) => m.id === 'sonnet').name, 'Sonnet 5.5')
})

test('a successful catalog refreshes after the TTL so new models show up without a restart', async () => {
  let version = 0
  const discover = async () => [{ value: 'sonnet', displayName: version ? 'Sonnet 6' : 'Sonnet 5.5', resolvedModel: version ? 'claude-sonnet-6' : 'claude-sonnet-5-5' }]
  const adapter = createClaudeCodeAdapter({ provider: 'claude-code', effort: 'medium', modelRefreshMs: 0 }, discover)
  assert.equal((await adapter.listModels('claude-code')).find((m) => m.id === 'sonnet').name, 'Sonnet 5.5')
  version = 1
  assert.equal((await adapter.listModels('claude-code')).find((m) => m.id === 'sonnet').name, 'Sonnet 6')
})

test('a discovery that never answers cannot hang the picker', async () => {
  const adapter = createClaudeCodeAdapter({ provider: 'claude-code', effort: 'medium', discoveryTimeoutMs: 100 }, () => new Promise(() => {}))
  const list = await Promise.race([adapter.listModels('claude-code'), new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG')), 3000))])
  assert.ok(list.length >= 4)
})

test('resolveModel exposes the discovered display name and effort levels', async () => {
  const adapter = createClaudeCodeAdapter({ provider: 'claude-code', effort: 'medium' }, async () => REAL)
  const info = await adapter.resolveModel('claude-code', 'sonnet')
  assert.equal(info.name, 'Sonnet 5.5')
  assert.equal(info.context.contextWindow, 1_000_000)
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), eff5)
})
