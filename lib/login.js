// Relogin flow: drive the official `claude auth login` on the DSH host.
//
// Compliance: the driver only spawns the user's own Claude Code CLI and relays
// its URL / pasted code. It never reads, stores or forwards OAuth tokens.
//
// Measured CLI 2.1.312, piped stdio (no PTY needed): stdout carries
//   "Opening browser to sign in…\nIf the browser didn't open, visit: <URL>\nPaste code here if prompted > "
// where <URL> is wrapped in an OSC-8 hyperlink (ESC]8;;URL BEL URL ESC]8;;BEL).
// A browser on the same host completes the login through the CLI's own
// callback; otherwise the user pastes the code the login page shows.
import { spawn as nodeSpawn } from 'node:child_process'

const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const URL_LINE = /https?:\/\/[^\s\x07\x1b]+(?=[\s\x07\x1b])/

const AUTH_PATTERNS = [
  /\b(?:401|403)\b/,
  /authenticat/i,
  /oauth.*(?:expired|refresh)/i,
  /not logged in/i,
  /invalid api key/i,
  /(?:run|please).{0,20}\/login/i,
]

export function isAuthFailureMessage(message) {
  const text = String(message)
  return AUTH_PATTERNS.some((pattern) => pattern.test(text))
}

// Env credentials that a fresh OAuth login cannot override.
export function credentialEnvVar(env = process.env) {
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].find((name) => env[name])
}

const stripAnsi = (text) => text.replace(ANSI_OSC, '').replace(ANSI_CSI, '')

// The URL appears twice in OSC-8 output (link target + visible text); take the
// first complete one. A URL not yet followed by a terminator may be truncated.
export function extractLoginUrl(output) {
  const hyperlink = /\x1b\]8;;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(output)
  if (hyperlink) return hyperlink[1]
  return URL_LINE.exec(stripAnsi(output))?.[0]
}

function failureMessage(output) {
  // The prompt has no trailing newline, so an error can share its line.
  const lines = stripAnsi(output)
    .replace(/Paste code here if prompted >/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^https?:\/\//.test(line) && !/visit:|Opening browser/.test(line))
  return lines.slice(-3).join(' ') || 'claude auth login exited without success'
}

/**
 * One manager per host. `start()` begins (or reuses) a login and resolves once
 * the URL is known or the CLI already ended; `done()` resolves with the final
 * snapshot. Snapshot: {status: idle|waiting|success|failed|cancelled, url?, message?}.
 */
export function createLoginManager({
  command = 'claude',
  args = ['auth', 'login'],
  env = process.env,
  spawn = nodeSpawn,
  timeoutMs = 10 * 60_000,
} = {}) {
  let flow // {child, output, snapshot, urlReady, finished}

  const snapshot = () => (flow ? { ...flow.snapshot } : { status: 'idle' })

  function begin() {
    const state = { output: '', snapshot: { status: 'waiting' } }
    let resolveUrl
    let resolveDone
    state.urlReady = new Promise((resolve) => { resolveUrl = resolve })
    state.finished = new Promise((resolve) => { resolveDone = resolve })

    const settle = (next) => {
      if (state.snapshot.status !== 'waiting') return
      state.snapshot = { ...state.snapshot, ...next }
      clearTimeout(state.timer)
      resolveUrl()
      resolveDone({ ...state.snapshot })
    }
    state.settle = settle

    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    state.child = child
    const onData = (chunk) => {
      state.output += chunk.toString()
      if (state.snapshot.url === undefined) {
        const url = extractLoginUrl(state.output)
        if (url) {
          state.snapshot = { ...state.snapshot, url, needsCode: true }
          resolveUrl()
        }
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.stdin?.on('error', () => {})
    child.on('error', (error) => settle({ status: 'failed', message: `could not run ${command}: ${error.message}` }))
    child.on('close', (code) => {
      if (code === 0) settle({ status: 'success', needsCode: false })
      else settle({ status: 'failed', needsCode: false, message: failureMessage(state.output) })
    })
    state.timer = setTimeout(() => {
      settle({ status: 'failed', needsCode: false, message: 'Login timed out waiting for the browser step' })
      child.kill('SIGTERM')
    }, timeoutMs)
    state.timer.unref?.()
    flow = state
    return state
  }

  return {
    async start() {
      const state = flow?.snapshot.status === 'waiting' ? flow : begin()
      await state.urlReady
      return { ...state.snapshot }
    },
    async done() {
      return flow ? flow.finished : { status: 'idle' }
    },
    submit(code) {
      const trimmed = String(code ?? '').trim()
      if (!flow || flow.snapshot.status !== 'waiting' || !trimmed) {
        return { ok: false, error: 'No login is waiting for a code. Run /claude-login first.' }
      }
      flow.child.stdin?.write(`${trimmed}\n`)
      return { ok: true }
    },
    cancel() {
      if (!flow || flow.snapshot.status !== 'waiting') return { ok: false }
      flow.settle({ status: 'cancelled', needsCode: false })
      flow.child.kill('SIGTERM')
      return { ok: true }
    },
    status: snapshot,
  }
}

const CODE_WAIT_MS = 30_000

function describeWaiting(snap) {
  return [
    `Open this URL and sign in to Claude: ${snap.url}`,
    'If the page shows a code, reply `/claude-login <code>`. If your browser is on the DSH host, the login finishes by itself — then resend your last message.',
  ].join('\n')
}

/** /claude-login [status|cancel|<code>] — dsh-commands register contract. */
export function createClaudeLoginCommand(manager) {
  return {
    name: 'claude-login',
    description: 'Sign in to Claude Code again (start the login, then paste the code with /claude-login <code>)',
    async handler(invocation) {
      const arg = String(invocation?.rawInput ?? '').replace(/^\s*\/?claude-login\b/i, '').trim()

      if (arg === 'status') {
        const snap = manager.status()
        return { kind: 'success', text: `Claude login: ${snap.status}${snap.message ? ` — ${snap.message}` : ''}` }
      }
      if (arg === 'cancel') {
        return manager.cancel().ok
          ? { kind: 'success', text: 'Claude login cancelled.' }
          : { kind: 'success', text: 'No Claude login is in progress.' }
      }
      if (arg) {
        const sent = manager.submit(arg)
        if (!sent.ok) return { kind: 'error', text: sent.error }
        const final = await Promise.race([manager.done(), new Promise((resolve) => setTimeout(resolve, CODE_WAIT_MS, undefined))])
        if (final?.status === 'success') return { kind: 'success', text: 'Logged in to Claude Code. Resend your last message.' }
        if (final) return { kind: 'error', text: `Claude login failed: ${final.message ?? final.status}. Run /claude-login to try again.` }
        return { kind: 'success', text: 'Code sent; the CLI has not confirmed yet. Check `/claude-login status`.' }
      }

      const snap = await manager.start()
      if (snap.status === 'waiting') return { kind: 'success', text: describeWaiting(snap) }
      if (snap.status === 'success') return { kind: 'success', text: 'Logged in to Claude Code. Resend your last message.' }
      return { kind: 'error', text: `Claude login failed: ${snap.message ?? snap.status}` }
    },
  }
}

export { describeWaiting }
