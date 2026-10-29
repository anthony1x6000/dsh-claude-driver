// Guarantees a Claude Code turn always ends. Two silent-hang shapes exist:
//   1. the CLI retries an unreachable API for minutes, emitting only
//      `system/api_retry` frames (dead or wrong proxy, no network);
//   2. the CLI never emits anything.
// Either way DSH sees no chunk and no finish: "thinking forever".

export const NETWORK_RETRY_LIMIT = 3
export const HTTP_RETRY_LIMIT = 6
export const STARTUP_TIMEOUT_MS = 120_000
export const PULSE_MS = 10_000
const PULSE_CAP_MS = 60_000

// Quiet-gap pulse schedule: the first pulse after `base` of silence, then the
// gap grows by `base` each time up to a cap, so a long wait is a few lines, not a wall.
export function pulseDelay(base, n) {
  return Math.min(base * (n + 1), Math.max(base, PULSE_CAP_MS))
}

const STALLED = Symbol('stalled')
const TICK = Symbol('tick')
const PROGRESS = new Set(['stream_event', 'assistant', 'user', 'result'])

export function createStallGuard(settings, onStall) {
  const startupMs = Number(settings.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)
  const networkLimit = Number(settings.apiRetryLimit ?? NETWORK_RETRY_LIMIT)
  const httpLimit = Number(settings.apiHttpRetryLimit ?? HTTP_RETRY_LIMIT)
  const pulseBase = Number(settings.pulseMs ?? PULSE_MS)
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
    const startedAt = Date.now()
    let lastAt = startedAt
    let pulses = 0
    // The one outstanding next(); fetched only when needed, so stopping right
    // after the last message never leaves a pending read to block return().
    let pending
    try {
      while (true) {
        let timer
        const tick = pulseBase > 0
          ? new Promise((resolve) => { timer = setTimeout(() => resolve(TICK), pulseDelay(pulseBase, pulses)); timer.unref?.() })
          : new Promise(() => {})
        pending ??= iterator.next()
        const step = await Promise.race([pending, stalled, tick])
        clearTimeout(timer)
        if (step === TICK) {
          // Silence: tell the consumer, without touching the watchdogs.
          pulses += 1
          yield { type: 'driver_pulse', elapsedMs: Date.now() - startedAt, idleMs: Date.now() - lastAt, count: pulses }
          continue
        }
        if (step === STALLED || step.done) return
        pending = undefined
        lastAt = Date.now()
        pulses = 0
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
