// Real Claude CLI: DSH full access must actually let Claude run a built-in Bash
// command that its default permission mode would refuse. The Anthropic API is a
// local double that asks Claude to `touch` a marker file; whether the file
// exists afterwards is the observable effect of the permission mode.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { startMockAnthropic } from './support/mock-anthropic.mjs'

const require = createRequire(import.meta.url)
let hasCli = true
try { require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude') } catch { hasCli = false }
const e2e = { skip: !hasCli && 'no claude binary available', timeout: 90000 }

// `acceptEdits` auto-approves file commands inside the working directory, so the
// marker lives OUTSIDE it: only a real permission bypass can create it.
const work = mkdtempSync(join(tmpdir(), 'e2e-perm-'))
const outside = mkdtempSync(join(tmpdir(), 'e2e-perm-outside-'))
const claudeHome = mkdtempSync(join(tmpdir(), 'e2e-perm-home-'))
const saved = {}
const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v } }
let mock
let markerFor

before(async () => {
  mock = await startMockAnthropic((body) => {
    if (!body.tools?.length) return [{ text: 'title' }]
    const convo = JSON.stringify(body.messages ?? [])
    if (convo.includes('tool_result')) return [{ text: 'finished' }]
    const marker = /MARKER=(\S+?)(?:\\|"|\s)/.exec(convo)?.[1]
    return [{ tool_use: { id: 'toolu_perm1', name: 'Bash', input: { command: `touch ${marker}`, description: 'touch marker' } } }]
  })
  setEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-e2e', CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
})
after(async () => {
  await mock?.close()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(work, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

async function turnUnder(sandbox, name) {
  const marker = join(outside, name)
  const session = { id: `sess-${name}`, events: [], header: { cwd: work } }
  const services = {
    agents: { currentInitiator: () => ({ id: 'a1', session }) },
    sandboxPolicy: { resolve: () => ({ mode: sandbox }) },
  }
  let handler
  apply({ logger: { info() {}, warn() {} }, on: (e, fn) => { if (e === 'llm/stream') handler = fn }, get: (n) => services[n] }, { cwd: work, resumeChain: false })
  const chunks = []
  const messages = [{ role: 'user', content: [{ type: 'text', text: `please run it MARKER=${marker} now` }] }]
  for await (const c of handler({ provider: 'claude-code', model: 'sonnet', messages }, () => { throw new Error('not claimed') })) chunks.push(c)
  return { marker, finish: chunks.at(-1) }
}

test('e2e: under DSH workspace-write Claude does not get to run an arbitrary Bash command', e2e, async () => {
  const { marker, finish } = await turnUnder('workspace-write', 'ww')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(existsSync(marker), false, 'acceptEdits must not run a command that touches outside the workspace')
})

test('e2e: under DSH full access (danger-full-access) Claude runs the Bash command', e2e, async () => {
  const { marker, finish } = await turnUnder('danger-full-access', 'full')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(existsSync(marker), true, 'bypassPermissions must let the command run')
})
