// Where the dependency check runs: at plugin load (background), before a turn that
// has no CLI, and on demand via /claude-doctor. Never as an npm install script.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, createClaudeDoctorCommand, streamClaudeChunks } from '../lib/index.js'
import { resetClaudeExecutableCache } from '../lib/claude-executable.js'
import { privateCliBinary } from '../lib/deps.js'

const root = join(import.meta.dirname, '..')
const tmp = (p) => mkdtempSync(join(tmpdir(), `wire-${p}-`))
const world = () => ({ stateDir: tmp('state'), homeDir: tmp('home'), env: { PATH: tmp('path') }, sdkBinaryDirs: [] })
const lay = (path) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n'); chmodSync(path, 0o755) }
const ctx = (extra = {}) => ({ logger: { info() {}, warn() {} }, on() {}, get: () => undefined, ...extra })
const opts = { provider: 'claude-code', model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }

test('the package has NO install-time scripts (pnpm refuses them for git-hosted plugins and would break `dsh plugin add`)', () => {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack']) assert.equal(scripts[name], undefined, name)
})

test('apply() checks the CLI in the background once, without blocking', async () => {
  const calls = []
  const ensureCli = async (o) => { calls.push(o); await new Promise((r) => setTimeout(r, 30)); return { action: 'none', source: 'path' } }
  const t0 = Date.now()
  apply(ctx(), { ensureCli, depsOptions: world() })
  assert.ok(Date.now() - t0 < 25, 'apply returned before the check finished')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls.length, 1)
})

test('apply() with autoInstallCli:false makes the check report-only', async () => {
  const calls = []
  apply(ctx(), { ensureCli: async (o) => { calls.push(o); return { action: 'skipped', reason: 'disabled' } }, autoInstallCli: false, depsOptions: world() })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls[0].autoInstall, false)
})

test('an install failure at load is logged, never thrown', async () => {
  const warns = []
  apply(ctx({ logger: { info() {}, warn: (...a) => warns.push(a.join(' ')) } }), { ensureCli: async () => ({ action: 'failed', error: 'offline' }), depsOptions: world() })
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(warns.some((w) => /offline/.test(w)), warns.join('|'))
})

test('a throwing check at load is contained', async () => {
  assert.doesNotThrow(() => apply(ctx(), { ensureCli: async () => { throw new Error('kaboom') }, depsOptions: world() }))
  await new Promise((r) => setTimeout(r, 30))
})

test('a turn with the CLI missing installs it first, tells the user, then runs with the installed binary', async () => {
  resetClaudeExecutableCache()
  const w = world()
  let seenExecutable
  const ensureCli = async () => { lay(privateCliBinary(w)); return { action: 'installed', source: 'private', path: privateCliBinary(w), version: '9.9.9 (Claude Code)' } }
  const queryImpl = ({ options }) => { seenExecutable = options.pathToClaudeCodeExecutable; return (async function* () {
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } }
    yield { type: 'result', subtype: 'success', session_id: 's', result: 'hi', usage: { input_tokens: 1, output_tokens: 1 } }
  })() }
  const chunks = []
  for await (const c of streamClaudeChunks(ctx(), opts, { resumeChain: false, ensureCli, depsOptions: w, queryImpl, checkCliBeforeTurn: true })) chunks.push(c)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.match(reasoning, /Claude Code CLI/i)
  assert.match(reasoning, /install/i)
  assert.equal(seenExecutable, privateCliBinary(w))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  resetClaudeExecutableCache()
})

test('a turn with the CLI missing and the install failing ends in a clear, actionable error', async () => {
  resetClaudeExecutableCache()
  const chunks = []
  for await (const c of streamClaudeChunks(ctx(), opts, { resumeChain: false, ensureCli: async () => ({ action: 'failed', error: 'EAI_AGAIN offline' }), depsOptions: world(), queryImpl: () => { throw new Error('must not start') }, checkCliBeforeTurn: true })) chunks.push(c)
  const f = chunks.at(-1)
  assert.equal(f.reason.kind, 'error')
  assert.match(f.reason.failure.message, /Claude Code CLI is not installed/)
  assert.match(f.reason.failure.message, /EAI_AGAIN offline/)
  assert.match(f.reason.failure.message, /claude-doctor/)
  resetClaudeExecutableCache()
})

test('a turn with the CLI already present does no install work at all', async () => {
  resetClaudeExecutableCache()
  const w = world(); lay(join(w.env.PATH, 'claude'))
  let called = 0
  const queryImpl = () => (async function* () { yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } } })()
  for await (const _ of streamClaudeChunks(ctx(), opts, { resumeChain: false, ensureCli: async () => { called += 1; return { action: 'none' } }, depsOptions: w, queryImpl, checkCliBeforeTurn: true })) void _
  assert.equal(called, 0)
  resetClaudeExecutableCache()
})

test('test doubles that inject queryImpl never trigger an install by default', async () => {
  let called = 0
  const queryImpl = () => (async function* () { yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } } })()
  for await (const _ of streamClaudeChunks(ctx(), opts, { resumeChain: false, ensureCli: async () => { called += 1; return { action: 'none' } }, depsOptions: world(), queryImpl })) void _
  assert.equal(called, 0)
})

test('autoInstallCli:false: a missing CLI is a clear error and nothing is installed', async () => {
  resetClaudeExecutableCache()
  let installs = 0
  const chunks = []
  for await (const c of streamClaudeChunks(ctx(), opts, { resumeChain: false, autoInstallCli: false, checkCliBeforeTurn: true, depsOptions: world(), ensureCli: async (o) => { if (o.autoInstall !== false) installs += 1; return { action: 'skipped', reason: 'disabled' } }, queryImpl: () => { throw new Error('must not start') } })) chunks.push(c)
  assert.equal(installs, 0)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /autoInstallCli/)
  resetClaudeExecutableCache()
})

test('/claude-doctor reports every dependency and never installs', async () => {
  const w = world(); lay(join(w.env.PATH, 'claude'))
  const cmd = createClaudeDoctorCommand({ depsOptions: w, run: async (c, a) => ({ code: 0, stdout: a[0] === 'auth' ? JSON.stringify({ loggedIn: true }) : '9.9.9 (Claude Code)', stderr: '' }) })
  assert.equal(cmd.name, 'claude-doctor')
  const r = await cmd.handler({ rawInput: '' })
  assert.equal(r.kind, 'success')
  for (const word of ['Node', 'Agent SDK', 'zod', 'Claude Code CLI', 'logged in']) assert.match(r.text, new RegExp(word, 'i'))
})

test('/claude-doctor says exactly what is missing and how to fix it', async () => {
  const w = world()
  const r = await createClaudeDoctorCommand({ depsOptions: w, run: async () => ({ code: 0, stdout: '', stderr: '' }) }).handler({ rawInput: '' })
  assert.match(r.text, /Claude Code CLI.*(missing|not found)/i)
  assert.match(r.text, /\/claude-doctor install/)
})

test('/claude-doctor install forces an install attempt even after a recent failure', async () => {
  const w = world(); let forced
  const cmd = createClaudeDoctorCommand({ depsOptions: w, ensureCli: async (o) => { forced = o.force; lay(privateCliBinary(w)); return { action: 'installed', path: privateCliBinary(w), version: '9.9.9' } } })
  const r = await cmd.handler({ rawInput: 'install' })
  assert.equal(forced, true)
  assert.match(r.text, /installed/i)
})

test('/claude-doctor install on a machine that already has the CLI changes nothing', async () => {
  const w = world(); lay(join(w.env.PATH, 'claude'))
  const r = await createClaudeDoctorCommand({ depsOptions: w, run: async () => ({ code: 0, stdout: '9.9.9', stderr: '' }) }).handler({ rawInput: 'install' })
  assert.match(r.text, /already installed/i)
})

test('/claude-doctor rejects unknown arguments with usage', async () => {
  const r = await createClaudeDoctorCommand({ depsOptions: world() }).handler({ rawInput: 'wat' })
  assert.equal(r.kind, 'error'); assert.match(r.text, /Usage/)
})
