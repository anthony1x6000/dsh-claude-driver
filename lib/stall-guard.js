// Guarantees a Claude Code turn always ends. Two silent-hang shapes exist:
//   1. the CLI retries an unreachable API for minutes, emitting only
//      `system/api_retry` frames (dead or wrong proxy, no network);
//   2. the CLI never emits anything.
// Either way DSH sees no chunk and no finish: "thinking forever".

export const NETWORK_RETRY_LIMIT = 3
export const HTTP_RETRY_LIMIT = 6
export const STARTUP_TIMEOUT_MS = 120_000

const STALLED = Symbol('stalled')
const PROGRESS = new Set(['stream_event', 'assistant', 'user', 'result'])

export function createStallGuard(settings, onStall) {
  const startupMs = Number(settings.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)
  const networkLimit = Number(settings.apiRetryLimit ?? NETWORK_RETRY_LIMIT)
  const httpLimit = Number(settings.apiHttpRetryLimit ?? HTTP_RETRY_LIMIT)
  let reason
  let resolveStalled
  const stalled = new Promise((resolve) => { resolveStalled = resolve })
  let startupTimer
  let streak = 0

  const trigger = (message) => {
    if (reason !== undefined) return
    reason = message
    clearTimeout(startupTimer)
    resolveStalled(STALLED)
    onStall()
  }

  const observe = (msg) => {
    clearTimeout(startupTimer)
    if (msg?.type === 'system' && msg.subtype === 'api_retry') {
      streak += 1
      const status = msg.error_status
      if (status == null && streak >= networkLimit) {
        trigger(`claude-driver: cannot reach the Anthropic API after ${streak} retries (network error). If a "proxy" is configured, check that it is running; otherwise remove it.`)
      } else if (status != null && streak >= httpLimit) {
        trigger(`claude-driver: the Anthropic API kept failing with status ${status} after ${streak} retries.`)
      }
    } else if (PROGRESS.has(msg?.type)) {
      streak = 0
    }
  }

  async function* guard(q) {
    if (startupMs > 0) {
      startupTimer = setTimeout(
        () => trigger(`claude-driver: startup timeout: Claude Code produced no output within ${Math.round(startupMs / 1000)}s.`),
        startupMs,
      )
      startupTimer.unref?.()
    }
    const iterator = q[Symbol.asyncIterator]()
    try {
      while (true) {
        const step = await Promise.race([iterator.next(), stalled])
        if (step === STALLED || step.done) return
        observe(step.value)
        if (reason !== undefined) return
        yield step.value
      }
    } finally {
      clearTimeout(startupTimer)
      // Never await a bare return(): on an aborted open-input query it can hang forever.
      let giveUp
      const bound = new Promise((resolve) => { giveUp = setTimeout(resolve, 2000); giveUp.unref?.() })
      await Promise.race([Promise.resolve().then(() => iterator.return?.()).catch(() => {}), bound])
      clearTimeout(giveUp)
    }
  }

  return { guard, reason: () => reason }
}
