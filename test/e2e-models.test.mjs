// Real Claude CLI: the catalog the picker gets from apply() shows the versions
// Claude Code reports, with no models configured. Needs no network (local control request).
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { apply } from '../lib/index.js'

const require = createRequire(import.meta.url)
let hasCli = true
try { require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude') } catch { hasCli = false }

test('e2e: picker lists current Claude Code models with real names', { skip: !hasCli && 'no claude binary', timeout: 60000 }, async () => {
  let adapter
  apply({
    logger: { info() {}, warn() {} },
    on() {},
    get: (name) => (name === 'llm' ? { listProviders: () => [], registerAdapter: (_p, a) => { adapter = a }, registerModelDiscovery() {} } : undefined),
  }, { cwd: tmpdir() })
  const list = await adapter.listModels('claude-code')
  const names = Object.fromEntries(list.map((m) => [m.id, m.name]))
  for (const id of ['fable', 'sonnet', 'opus', 'haiku']) {
    assert.match(names[id], /\d/, `${id} shows a version, got "${names[id]}"`)
    assert.notEqual(names[id], id)
  }
  assert.ok(!('default' in names))
  const info = await adapter.resolveModel('claude-code', 'sonnet')
  assert.ok(info.context.contextWindow >= 200_000)
})
