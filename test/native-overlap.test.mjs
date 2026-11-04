// Where DSH and Claude Code both have a feature, the DSH one is the source of
// truth on a claude-code turn: Claude's built-in duplicate is withheld so the
// model uses the DSH tool (which DSH renders, persists and governs).
//
// The exception runs the other way — `read_image` is withheld in favour of
// Claude's `Read`, because an image inside a bridged tool result cannot reach
// the model as pixels (see the last two tests).
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

// The one overlap that runs the other way: an image block inside a bridged tool
// result cannot cross the MCP boundary, so the DSH tool is withheld and Claude's
// own Read (which returns the image itself) is the only way to look at an image.
test('DSH read_image is not bridged: Claude\'s own Read is the image path', () => {
  const options = { provider: 'claude-code', model: 'sonnet', messages: [], tools: ['read_image', 'bash'].map(schema) }
  const controller = new AbortController()
  const settings = { model: 'sonnet', nativeToolCards: false }
  const bridge = buildToolBridge(ctx, options, settings, controller)
  assert.ok(!bridge.bridgedNames.has('read_image'), 'read_image is not advertised to Claude')
  assert.ok(!bridge.handlers.has('read_image'), 'no bridge handler executes it either')
  assert.deepEqual(Object.keys(bridge.mcpServers['dsh-tools'].instance?._registeredTools ?? {}), ['bash'])
  const sdk = buildSdkOptions(ctx, options, settings, { controller, model: 'sonnet', bridge })
  assert.ok(!(sdk.disallowedTools ?? []).includes('Read'), 'Claude\'s Read stays: it returns the image itself')
})

test('a bridged result that carries an image would reach Claude as JSON text, not pixels', async () => {
  // Pins the constraint the withholding above follows from: toSdkToolResult
  // flattens every non-text block, so re-bridging read_image would hand Claude
  // image metadata instead of the image.
  const imageCtx = {
    ...ctx,
    get: (n) =>
      n === 'tools'
        ? { execute: async () => ({ content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] }) }
        : n === 'agents'
          ? { currentInitiator: () => agent }
          : undefined,
  }
  const bridge = buildToolBridge(imageCtx, { provider: 'claude-code', model: 'sonnet', messages: [], tools: [schema('screenshot')] }, { model: 'sonnet', nativeToolCards: false }, new AbortController())
  const out = await bridge.handlers.get('screenshot')({})
  assert.deepEqual(out.content.map((block) => block.type), ['text'])
  assert.match(out.content[0].text, /"type":"image"/)
})
