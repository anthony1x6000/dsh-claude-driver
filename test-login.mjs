// Unit tests (no network, no real `claude`) for the relogin flow (2026-10-29):
// when Claude Code's OAuth session expires, the driver walks the user through
// `claude auth login` itself instead of surfacing a dead-end error.
//   1. extractLoginUrl           -> URL out of OSC-8 / plain CLI output
//   2. isAuthFailureMessage      -> expired / missing / revoked login detected
//   3. login flow (fake CLI)     -> waiting+url, code submit, auto (callback)
//                                   completion, failure, cancel, timeout
//   4. stream wrapper            -> AUTH failure => login => ONE retry; failed
//                                   login / API-key env / repeat AUTH keep the
//                                   original error (+ hint), never loop
//   5. /claude-login command     -> start, submit code, status, cancel
// Run: node test-login.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createClaudeLoginCommand,
  createLoginManager,
  extractLoginUrl,
  isAuthFailureMessage,
} from './lib/login.js'
import { classifyFailure, streamClaudeChunks } from './lib/index.js'

const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz'

// --- 1. extractLoginUrl ------------------------------------------------------
{
  const osc8 = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${URL_}\x07${URL_}\x1b]8;;\x07\r\nPaste code here if prompted > `
  assert.equal(extractLoginUrl(osc8), URL_, 'OSC-8 hyperlink wrapper stripped, URL not duplicated')
  const plain = `If the browser didn't open, visit: ${URL_}\nPaste code here if prompted > `
  assert.equal(extractLoginUrl(plain), URL_)
  assert.equal(extractLoginUrl('Opening browser to sign in…\n'), undefined, 'no URL yet')
  assert.equal(extractLoginUrl(`visit: ${URL_}`), undefined, 'URL line not yet terminated => may be truncated, wait')
}

// --- 2. isAuthFailureMessage / classifyFailure --------------------------------
{
  for (const m of [
    'Failed to authenticate: OAuth session expired and could not be refreshed (run `claude /login` on the DSH host, then retry)',
    'API Error: 401 {"type":"authentication_error"}',
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    'HTTP 403 forbidden',
  ]) {
    assert.equal(isAuthFailureMessage(m), true, m)
    assert.equal(classifyFailure(m), 'AUTH', m)
  }
  for (const m of ['rate limit 429', 'socket hang up', 'claude-code returned an empty response']) {
    assert.equal(isAuthFailureMessage(m), false, m)
  }
}

// --- fake `claude auth login` --------------------------------------------------
// FAKE_MODE: code   -> waits for a stdin line; "GOOD" => exit 0, else exit 1
//            auto   -> browser callback: exits 0 by itself after 50ms
//            hang   -> never exits (timeout / cancel tests)
//            nourl  -> exits 1 immediately without printing a URL
const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
const fake = join(dir, 'fake-claude.mjs')
writeFileSync(
  fake,
  `
const mode = process.env.FAKE_MODE
const url = ${JSON.stringify(URL_)}
if (mode === 'nourl') { console.error('network down'); process.exit(1) }
process.stdout.write('Opening browser to sign in…\\n')
process.stdout.write('If the browser didn\\'t open, visit: \\x1b]8;;' + url + '\\x07' + url + '\\x1b]8;;\\x07\\n')
process.stdout.write('Paste code here if prompted > ')
if (mode === 'auto') setTimeout(() => { console.log('Login successful.'); process.exit(0) }, 50)
else if (mode === 'code') {
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    const i = buf.indexOf('\\n')
    if (i < 0) return
    if (buf.slice(0, i).trim() === 'GOOD') { console.log('Login successful.'); process.exit(0) }
    console.error('Invalid code'); process.exit(1)
  })
} else setInterval(() => {}, 1000)
`,
)
const manager = (mode, extra = {}) =>
  createLoginManager({ command: process.execPath, args: [fake], env: { ...process.env, FAKE_MODE: mode }, ...extra })

// --- 3. login flow ---------------------------------------------------------------
{
  // code paste => success
  const m = manager('code')
  const snap = await m.start()
  assert.equal(snap.status, 'waiting')
  assert.equal(snap.url, URL_)
  assert.equal(m.status().status, 'waiting')
  const again = await m.start()
  assert.equal(again.url, URL_, 'start() while waiting reuses the running flow')
  m.submit('GOOD')
  const final = await m.done()
  assert.equal(final.status, 'success')
  assert.equal(m.status().status, 'success')

  // wrong code => failed with CLI message
  const bad = manager('code')
  await bad.start()
  bad.submit('NOPE')
  const failed = await bad.done()
  assert.equal(failed.status, 'failed')
  assert.match(failed.message, /Invalid code/)

  // browser callback on the same host => success with no code
  const auto = manager('auto')
  await auto.start()
  assert.equal((await auto.done()).status, 'success')

  // CLI dies before printing a URL => start() resolves failed, not hung
  const nourl = manager('nourl')
  const nourlSnap = await nourl.start()
  assert.equal(nourlSnap.status, 'failed')
  assert.match(nourlSnap.message, /network down/)

  // cancel kills the child
  const hang = manager('hang')
  await hang.start()
  hang.cancel()
  assert.equal((await hang.done()).status, 'cancelled')

  // timeout kills the child
  const slow = manager('hang', { timeoutMs: 100 })
  await slow.start()
  const timedOut = await slow.done()
  assert.equal(timedOut.status, 'failed')
  assert.match(timedOut.message, /timed out/i)

  // submit with no flow waiting is a clear error, not a crash
  assert.equal(manager('hang').submit('x').ok, false)

  // a finished flow can be restarted
  const restart = manager('auto')
  await restart.start()
  await restart.done()
  const second = await restart.start()
  assert.equal(second.status, 'waiting', 'new flow after the previous one finished')
  await restart.done()
}

// --- 4. stream wrapper ---------------------------------------------------------------
const AUTH_MSG = 'Failed to authenticate: OAuth session expired and could not be refreshed'
const ctx = { logger: { info: () => {}, warn: () => {} }, get: () => undefined }
const TURN = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

// Fake SDK query: first `authFailures` calls end in an error result, then success.
function fakeQuery(calls, { authFailures = 1 } = {}) {
  return ({ options }) => {
    calls.push(options)
    const fail = calls.length <= authFailures
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' + calls.length }
      if (fail) yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [AUTH_MSG], session_id: 's' }
      else yield { type: 'result', subtype: 'success', session_id: 's', result: 'welcome back', usage: { output_tokens: 1 } }
    })()
  }
}

// Fake login manager injected via settings.loginImpl.
function fakeLogin(outcome, log = []) {
  return {
    async start() {
      log.push('start')
      return { status: 'waiting', url: URL_, needsCode: true }
    },
    async done() {
      log.push('done')
      return outcome
    },
    submit: () => ({ ok: true }),
    cancel: () => {},
    status: () => ({ status: 'idle' }),
  }
}

let runs = 0 // unique DSH session per run: the resume chain must not leak between cases
async function run(settings) {
  const chunks = []
  for await (const c of streamClaudeChunks(ctx, { provider: 'claude-code', model: 'sonnet', sessionId: `login-conv-${++runs}`, messages: TURN }, { harvestOrphanedSubagents: false, ...settings })) chunks.push(c)
  return chunks
}
const finishOf = (cs) => cs.find((c) => c.type === 'finish')
const reasoningOf = (cs) => cs.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
const textOf = (cs) => cs.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN

{
  // AUTH => login succeeds => exactly one retry, turn completes, URL was shown
  const calls = [], log = []
  const cs = await run({ queryImpl: fakeQuery(calls), loginImpl: fakeLogin({ status: 'success' }, log) })
  assert.equal(calls.length, 2, 'original attempt + exactly one retry')
  assert.deepEqual(log, ['start', 'done'])
  assert.equal(finishOf(cs).reason.kind, 'stop')
  assert.equal(textOf(cs), 'welcome back')
  assert.ok(reasoningOf(cs).includes(URL_), 'login URL surfaced to the user while waiting')
  assert.ok(cs.filter((c) => c.type === 'finish').length === 1, 'a single finish chunk')
}
{
  // login fails => original AUTH error kept, hint appended, no retry
  const calls = []
  const cs = await run({ queryImpl: fakeQuery(calls), loginImpl: fakeLogin({ status: 'failed', message: 'Invalid code' }) })
  assert.equal(calls.length, 1, 'no retry after failed login')
  const f = finishOf(cs).reason
  assert.equal(f.kind, 'error')
  assert.equal(f.failure.code, 'AUTH')
  assert.match(f.failure.message, /OAuth session expired/)
  assert.match(f.failure.message, /\/claude-login/)
}
{
  // retry hits AUTH again => no second login (no loop)
  const calls = [], log = []
  const cs = await run({ queryImpl: fakeQuery(calls, { authFailures: 5 }), loginImpl: fakeLogin({ status: 'success' }, log) })
  assert.equal(calls.length, 2)
  assert.deepEqual(log, ['start', 'done'], 'login ran once')
  assert.equal(finishOf(cs).reason.failure.code, 'AUTH')
}
{
  // autoLogin:false => no flow, error + hint only
  const calls = [], log = []
  const cs = await run({ queryImpl: fakeQuery(calls), autoLogin: false, loginImpl: fakeLogin({ status: 'success' }, log) })
  assert.equal(calls.length, 1)
  assert.deepEqual(log, [])
  assert.match(finishOf(cs).reason.failure.message, /\/claude-login/)
}
{
  // API key in env => a login would not help; explain instead of starting one
  process.env.ANTHROPIC_API_KEY = 'sk-bad'
  const calls = [], log = []
  const cs = await run({ queryImpl: fakeQuery(calls), loginImpl: fakeLogin({ status: 'success' }, log) })
  delete process.env.ANTHROPIC_API_KEY
  assert.equal(calls.length, 1)
  assert.deepEqual(log, [])
  const m = finishOf(cs).reason.failure.message
  assert.match(m, /ANTHROPIC_API_KEY/)
  assert.doesNotMatch(m, /\/claude-login/)
}
{
  // query() THROWING an auth error (the live "Failed to authenticate" shape) retries too
  const calls = [], log = []
  const q = ({ options }) => {
    calls.push(options)
    if (calls.length === 1) throw new Error(AUTH_MSG)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      yield { type: 'result', subtype: 'success', session_id: 's', result: 'welcome back', usage: { output_tokens: 1 } }
    })()
  }
  const cs = await run({ queryImpl: q, loginImpl: fakeLogin({ status: 'success' }, log) })
  assert.equal(calls.length, 2)
  assert.equal(finishOf(cs).reason.kind, 'stop')
}
{
  // non-auth failure is untouched
  const calls = [], log = []
  const q = ({ options }) => {
    calls.push(options)
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limit 429'], session_id: 's' }
    })()
  }
  const cs = await run({ queryImpl: q, loginImpl: fakeLogin({ status: 'success' }, log) })
  assert.equal(calls.length, 1)
  assert.deepEqual(log, [])
  assert.equal(finishOf(cs).reason.failure.code, 'RATE_LIMIT')
}

// --- 5. /claude-login command -----------------------------------------------------------
{
  const m = manager('code')
  const cmd = createClaudeLoginCommand(m)
  assert.equal(cmd.name, 'claude-login')
  assert.ok(cmd.description)

  const started = await cmd.handler({ rawInput: '/claude-login' })
  assert.equal(started.kind, 'success')
  assert.ok(started.text.includes(URL_), 'URL in the reply')
  assert.match(started.text, /\/claude-login <code>/, 'tells the user how to paste the code')

  const st = await cmd.handler({ rawInput: '/claude-login status' })
  assert.match(st.text, /waiting/i)

  const wrong = await cmd.handler({ rawInput: '/claude-login NOPE' })
  assert.equal((await m.done()).status, 'failed')
  assert.ok(wrong.kind === 'success' || wrong.kind === 'error')

  const m2 = manager('code')
  const cmd2 = createClaudeLoginCommand(m2)
  await cmd2.handler({ rawInput: '/claude-login' })
  const ok = await cmd2.handler({ rawInput: '/claude-login GOOD' })
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /logged in|success/i)

  const m3 = manager('hang')
  const cmd3 = createClaudeLoginCommand(m3)
  await cmd3.handler({ rawInput: 'claude-login' })
  const cancelled = await cmd3.handler({ rawInput: '/claude-login cancel' })
  assert.equal(cancelled.kind, 'success')
  assert.equal((await m3.done()).status, 'cancelled')

  const noFlow = await createClaudeLoginCommand(manager('hang')).handler({ rawInput: '/claude-login ABC' })
  assert.equal(noFlow.kind, 'error', 'code with no login in progress is an error')
}

console.log('test-login: all passed')
process.exit(0)
