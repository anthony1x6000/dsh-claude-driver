// Where DSH and Claude Code both have a feature, the DSH one is the source of
// truth on a claude-code turn: Claude's built-in duplicate is withheld so the
// model uses the DSH tool (which DSH renders, persists and governs).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSdkOptions, buildToolBridge, DSH_OWNED_BUILTINS } from '../lib/index.js'

const agent = { id: 'a' }
const ctx = { logger: { info() {}, warn() {} }, get: (n) => (n === 'tools' ? { execute: async () => ({ content: [] }) } : n === 'agents' ? { currentInitiator: () => agent } : undefined) }
const schema = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
function optionsWith(names) {
  const options = { provider: 'claude-code', model: 'sonnet', messages: [], tools: names.map(schema) }
  const controller = new AbortController()
  const settings = { model: 'sonnet', nativeToolCards: false }
  const bridge = buildToolBridge(ctx, options, settings, controller)
  return buildSdkOptions(ctx, options, settings, { controller, model: 'sonnet', bridge })
}

test('DSH plan mode owns planning: Claude\'s EnterPlanMode/ExitPlanMode are withheld when exit_plan_mode is bridged', () => {
  const sdk = optionsWith(['exit_plan_mode', 'bash'])
  assert.ok(sdk.disallowedTools.includes('EnterPlanMode'))
  assert.ok(sdk.disallowedTools.includes('ExitPlanMode'))
})

test('DSH schedule owns cron: Claude\'s Cron tools are withheld when schedule_create is bridged', () => {
  const sdk = optionsWith(['schedule_create', 'schedule_list', 'schedule_delete'])
  for (const t of ['CronCreate', 'CronList', 'CronDelete']) assert.ok(sdk.disallowedTools.includes(t), t)
})

test('DSH todo owns the task list: Claude\'s TodoWrite is withheld when todo_write is bridged', () => {
  assert.ok(optionsWith(['todo_write']).disallowedTools.includes('TodoWrite'))
})

test('DSH web owns search/fetch: Claude\'s WebSearch/WebFetch are withheld when DSH web tools are bridged', () => {
  const sdk = optionsWith(['web_search', 'web_fetch'])
  assert.ok(sdk.disallowedTools.includes('WebSearch'))
  assert.ok(sdk.disallowedTools.includes('WebFetch'))
})

test('a Claude built-in stays when DSH does not offer the equivalent', () => {
  const sdk = optionsWith(['bash'])
  for (const t of ['EnterPlanMode', 'CronCreate', 'TodoWrite', 'WebSearch']) assert.ok(!(sdk.disallowedTools ?? []).includes(t), t)
})

test('preferDshTools:false keeps every Claude built-in', () => {
  const options = { provider: 'claude-code', model: 'sonnet', messages: [], tools: ['exit_plan_mode', 'web_search'].map(schema) }
  const controller = new AbortController()
  const settings = { model: 'sonnet', nativeToolCards: false, preferDshTools: false }
  const sdk = buildSdkOptions(ctx, options, settings, { controller, model: 'sonnet', bridge: buildToolBridge(ctx, options, settings, controller) })
  assert.ok(!(sdk.disallowedTools ?? []).includes('ExitPlanMode'))
})

test('the overlap table is exported for the feature map', () => {
  assert.equal(DSH_OWNED_BUILTINS.exit_plan_mode.join(','), 'EnterPlanMode,ExitPlanMode')
})
