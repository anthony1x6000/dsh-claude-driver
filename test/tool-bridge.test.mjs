// Guarantee: a tool registered with DSH reaches Claude Code's MCP tool list,
// and Claude calling it executes inside DSH (tools.execute) with the result
// returned to Claude. Uses the settings.queryImpl seam: no network, no CLI.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamClaudeChunks } from '../lib/index.js'

const FAKE_TOOL = {
  name: 'fake_plugin_tool',
  description: 'Echo from a fake DSH plugin.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' }, times: { type: 'number' } },
    required: ['text'],
  },
}

function harness() {
  const executed = []
  const agent = { id: 'a1' }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'tools') {
        return {
          execute: async (call) => {
            executed.push(call)
            return { content: [{ type: 'text', text: `echo:${call.arguments.text}` }], isError: false }
          },
        }
      }
      if (name === 'agents') return { currentInitiator: () => agent }
      return undefined
    },
  }
  return { ctx, executed, agent }
}

async function runTurn(ctx, tools, settings = {}) {
  let captured
  const queryImpl = ({ options }) => {
    captured = options
    return (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 's1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
  }
  const chunks = []
  for await (const chunk of streamClaudeChunks(
    ctx,
    { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools },
    { resumeChain: false, nativeToolCards: false, queryImpl, ...settings },
  )) chunks.push(chunk)
  return { captured, chunks }
}

test('a DSH-registered tool is exposed on Claude\'s MCP server', async () => {
  const { ctx } = harness()
  const { captured } = await runTurn(ctx, [FAKE_TOOL])
  assert.equal(captured.mcpServers.length, 1)
  const server = captured.mcpServers[0]
  assert.equal(server.type, 'sdk')
  assert.equal(server.name, 'dsh-tools')
  const registered = server.instance?._registeredTools
  if (registered) assert.ok(FAKE_TOOL.name in registered, 'tool is registered on the MCP server instance')
})

test('Claude calling the bridged tool executes it inside DSH and gets the result', async () => {
  const { ctx, executed, agent } = harness()
  const { captured } = await runTurn(ctx, [FAKE_TOOL])
  const registered = captured.mcpServers[0].instance?._registeredTools
  assert.ok(registered?.[FAKE_TOOL.name], 'SDK MCP server exposes the tool handler')
  const out = await registered[FAKE_TOOL.name].handler({ text: 'hello', times: 2 }, {})
  assert.equal(executed.length, 1, 'DSH tools.execute ran exactly once')
  assert.equal(executed[0].name, FAKE_TOOL.name)
  assert.deepEqual(executed[0].arguments, { text: 'hello', times: 2 })
  assert.equal(executed[0].agent, agent)
  assert.match(JSON.stringify(out), /echo:hello/)
  assert.notEqual(out.isError, true)
})

test('bridged tools are allowed through canUseTool so DSH owns approval', async () => {
  const { ctx } = harness()
  const { captured } = await runTurn(ctx, [FAKE_TOOL])
  const verdict = await captured.canUseTool(`mcp__dsh-tools__${FAKE_TOOL.name}`, { text: 'x' }, {})
  assert.equal(verdict.behavior, 'allow')
})

test('bridgeTools:false keeps DSH tools off Claude\'s MCP list', async () => {
  const { ctx } = harness()
  const { captured } = await runTurn(ctx, [FAKE_TOOL], { bridgeTools: false })
  assert.equal(captured.mcpServers, undefined)
})
