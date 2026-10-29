// DSH permission state must reach Claude Code: the session's sandbox mode and
// approval policy (what "full access" means in DSH) decide the permission mode
// of every Claude CLI process the driver spawns. Pure unit tests, no CLI.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSdkOptions,
  createPrewarmEntry,
  prewarmAdoptable,
  streamClaudeChunks,
  takePrewarm,
} from '../lib/index.js'
import { claudePermissionsFor, readDshPermissions, resolvePermissions } from '../lib/permission-sync.js'

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const opts = { provider: 'claude-code', model: 'sonnet', messages: [user('hi')] }

// A DSH-shaped ctx whose session state can change between turns.
function dshCtx(state = {}) {
  const session = { id: 'sess-1', events: state.events ?? [], header: { cwd: '/tmp' } }
  const live = { sandbox: state.sandbox, approval: state.approval }
  const services = {
    agents: { currentInitiator: () => ({ id: 'a1', session }) },
  }
  if (state.services !== false) {
    services.sandboxPolicy = { resolve: () => ({ mode: live.sandbox ?? 'read-only' }), overrideOf: () => live.sandbox }
    services.approval = { overrideOf: () => live.approval }
  }
  return { live, session, ctx: { logger: { info() {}, warn() {} }, get: (name) => services[name] } }
}
const sdk = (ctx, settings = {}) =>
  buildSdkOptions(ctx, opts, { model: 'sonnet', ...settings }, { controller: new AbortController(), model: 'sonnet' })

test('claudePermissionsFor maps every DSH sandbox mode', () => {
  assert.deepEqual(claudePermissionsFor({ sandbox: 'danger-full-access', approval: 'never' }), { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
  assert.deepEqual(claudePermissionsFor({ sandbox: 'workspace-write', approval: 'ask' }), { permissionMode: 'acceptEdits' })
  assert.deepEqual(claudePermissionsFor({ sandbox: 'read-only', approval: 'ask' }), { permissionMode: 'plan' })
  assert.deepEqual(claudePermissionsFor({}), { permissionMode: 'acceptEdits' })
})

test('DSH full access (danger-full-access) makes Claude bypass its own permission prompts', () => {
  const { ctx } = dshCtx({ sandbox: 'danger-full-access', approval: 'never' })
  const o = sdk(ctx)
  assert.equal(o.permissionMode, 'bypassPermissions')
  assert.equal(o.allowDangerouslySkipPermissions, true)
})

test('full access is honoured even while DSH approval is still "ask"', () => {
  const { ctx } = dshCtx({ sandbox: 'danger-full-access', approval: 'ask' })
  assert.equal(sdk(ctx).permissionMode, 'bypassPermissions')
})

test('workspace-write maps to acceptEdits and read-only to plan, without the bypass flag', () => {
  const ww = sdk(dshCtx({ sandbox: 'workspace-write', approval: 'ask' }).ctx)
  assert.equal(ww.permissionMode, 'acceptEdits')
  assert.equal(ww.allowDangerouslySkipPermissions, undefined)
  const ro = sdk(dshCtx({ sandbox: 'read-only' }).ctx)
  assert.equal(ro.permissionMode, 'plan')
  assert.equal(ro.allowDangerouslySkipPermissions, undefined)
})

test('a mode switch between turns changes the next turn', () => {
  const { ctx, live } = dshCtx({ sandbox: 'workspace-write' })
  assert.equal(sdk(ctx).permissionMode, 'acceptEdits')
  live.sandbox = 'danger-full-access'
  assert.equal(sdk(ctx).permissionMode, 'bypassPermissions')
  live.sandbox = 'read-only'
  assert.equal(sdk(ctx).permissionMode, 'plan')
})

test('state is recovered from the session log when the services are not mounted', () => {
  const events = [
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', data: { policy: 'never' } },
  ]
  const { ctx, session } = dshCtx({ events, services: false })
  assert.deepEqual(readDshPermissions(ctx, session), { sandbox: 'danger-full-access', approval: 'never' })
  assert.equal(sdk(ctx).permissionMode, 'bypassPermissions')
})

test('an explicitly configured permissionMode always wins over DSH state', () => {
  const { ctx } = dshCtx({ sandbox: 'danger-full-access' })
  const o = sdk(ctx, { permissionMode: 'default' })
  assert.equal(o.permissionMode, 'default')
  assert.equal(o.allowDangerouslySkipPermissions, undefined)
  assert.equal(resolvePermissions(ctx, { permissionMode: 'plan' }, undefined).source, 'config')
})

test('an explicit bypassPermissions config still carries the SDK opt-in flag', () => {
  const o = sdk(dshCtx({ sandbox: 'read-only' }).ctx, { permissionMode: 'bypassPermissions' })
  assert.equal(o.permissionMode, 'bypassPermissions')
  assert.equal(o.allowDangerouslySkipPermissions, true)
})

test('followDshPermissions:false pins the legacy acceptEdits default', () => {
  const o = sdk(dshCtx({ sandbox: 'danger-full-access' }).ctx, { followDshPermissions: false })
  assert.equal(o.permissionMode, 'acceptEdits')
})

test('with no DSH session at all the driver keeps the safe acceptEdits default', () => {
  const o = sdk({ logger: { info() {}, warn() {} }, get: () => undefined })
  assert.equal(o.permissionMode, 'acceptEdits')
})

test('a throwing DSH service never breaks a turn', () => {
  const ctx = { logger: { info() {}, warn() {} }, get: (n) => (n === 'agents' ? { currentInitiator: () => { throw new Error('boom') } } : undefined) }
  assert.equal(sdk(ctx).permissionMode, 'acceptEdits')
})

test('a prewarmed process spawned under another permission mode is not adoptable', () => {
  const { ctx, live } = dshCtx({ sandbox: 'workspace-write' })
  const queryImpl = () => (async function* () { await new Promise(() => {}) })()
  const settings = { model: 'sonnet', effort: 'medium', prewarm: true, resumeChain: true, queryImpl }
  const entry = createPrewarmEntry(ctx, opts, settings, { chainKey: 'k1', resumeId: 'r1' })
  try {
    assert.equal(entry.permissionMode, 'acceptEdits')
    const expected = { resumeId: 'r1', model: 'sonnet', effort: 'medium', toolKey: entry.toolKey, permissionMode: 'acceptEdits' }
    assert.equal(prewarmAdoptable(entry, expected), true)
    live.sandbox = 'danger-full-access'
    assert.equal(prewarmAdoptable(entry, { ...expected, permissionMode: 'bypassPermissions' }), false)
  } finally {
    entry.dispose('test')
  }
})

test('end to end: full access enabled after a prewarm forces a cold spawn with bypass', async () => {
  const { ctx, live } = dshCtx({ sandbox: 'workspace-write' })
  const spawns = []
  const queryImpl = ({ options }) => {
    spawns.push(options)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-chain' }
      yield { type: 'assistant', session_id: 's-chain', message: { content: [{ type: 'text', text: 'ok' }] } }
      yield { type: 'result', subtype: 'success', session_id: 's-chain', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
      await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve, { once: true }))
    })()
  }
  const settings = { provider: 'claude-code', model: 'sonnet', prewarm: true, resumeChain: true, queryImpl, startupTimeoutMs: 0 }
  const turn = async (text) => {
    const chunks = []
    for await (const c of streamClaudeChunks(ctx, { ...opts, sessionId: 'dsh-1', messages: [user(text)] }, settings)) chunks.push(c)
    return chunks
  }
  await turn('first')
  assert.equal(spawns[0].permissionMode, 'acceptEdits')
  assert.equal(spawns.length, 2, 'turn one booted a prewarmed process')
  assert.equal(spawns[1].permissionMode, 'acceptEdits')
  live.sandbox = 'danger-full-access'
  await turn('second')
  const last = spawns.at(-1)
  assert.equal(last.permissionMode, 'bypassPermissions', 'the turn after the switch must not reuse the old-mode process')
  assert.equal(last.allowDangerouslySkipPermissions, true)
  const stale = takePrewarm(`dsh-1`)
  stale?.dispose('test cleanup')
})

test('the claude-code subagent follows the delegating session’s DSH permissions', async () => {
  const { createClaudeCodeProvider } = await import('../lib/subagent-provider.js')
  const seen = []
  const queryImpl = ({ options }) => {
    seen.push(options)
    return (async function* () { yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's' } })()
  }
  for (const [sandbox, mode, flag] of [['danger-full-access', 'bypassPermissions', true], ['workspace-write', 'acceptEdits', undefined], ['read-only', 'plan', undefined]]) {
    const { ctx, session } = dshCtx({ sandbox })
    session.meta = { cwd: '/tmp' }
    const handle = await createClaudeCodeProvider({ queryImpl }, ctx).start({ prompt: [{ type: 'text', text: 'q' }], parent: { session }, signal: new AbortController().signal })
    await handle.result
    await handle.dispose()
    assert.equal(seen.at(-1).permissionMode, mode, sandbox)
    assert.equal(seen.at(-1).allowDangerouslySkipPermissions, flag, sandbox)
  }
})

test('a settings object carrying permissionMode: undefined (apply() defaults) does not disable the subagent default', async () => {
  const { createClaudeCodeProvider } = await import('../lib/subagent-provider.js')
  let seen
  const queryImpl = ({ options }) => { seen = options; return (async function* () { yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's' } })() }
  const handle = await createClaudeCodeProvider({ queryImpl, permissionMode: undefined }, undefined).start({ prompt: [{ type: 'text', text: 'q' }], parent: { session: { id: 'x', meta: { cwd: '/tmp' } } }, signal: new AbortController().signal })
  await handle.result
  assert.equal(seen.permissionMode, 'acceptEdits')
})
