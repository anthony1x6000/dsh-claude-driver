// Mirrors Claude Code's own background tasks (Bash `run_in_background`, Agent
// tasks, monitors) into DSH's job registry, so they show up in `job_list`,
// `job_output`, `job_kill` and the jobs panel instead of living only inside the
// Claude process. The Claude side stays the source of truth: the mirror only
// registers, narrates and settles; it never runs anything itself.
//
// Lifecycle per task: `background_tasks_changed` (level) opens a job the first
// time a task appears; `task_progress` updates its progress line;
// `task_notification` settles it with the real outcome; a task that vanishes
// from the level without a notice settles as completed; whatever is still open
// when the run is torn down settles as killed, so no job is left dangling.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export const JOB_KIND = 'claude-task'
const OUTPUT_TAIL_BYTES = 64 * 1024
const DETAIL_CHARS = 200
const STOP_CONFIRM_MS = 10_000
const STATUS = { completed: 'completed', failed: 'failed', stopped: 'killed' }

const firstLine = (text) => {
  const line = String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? ''
  return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS)}…` : line
}

function readTail(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, OUTPUT_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return { text: buffer.toString('utf8'), truncated: size > length }
  } catch {
    // The file is advisory output: a missing or unreadable one must not block settlement.
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * @param options.ctx - plugin context; `ctx.get('jobs')` is the DSH job registry.
 * @param options.session - the DSH session that owns the mirrored jobs.
 * @param options.stopTask - `(claudeTaskId) => Promise|void`, forwards a DSH kill to Claude.
 * @param options.enabled - false turns the mirror into a no-op.
 */
export function createJobMirror({ ctx, session, stopTask, enabled = true }) {
  let jobs
  if (enabled) {
    try {
      jobs = ctx?.get?.('jobs')
    } catch {
      // registry service unavailable: the mirror stays a no-op
    }
  }
  if (typeof jobs?.start !== 'function') jobs = undefined

  const open = new Map() // claude task id -> entry
  const settled = new Map() // claude task id -> run id of the settled run
  const skipped = new Set() // tasks whose registration failed; never retried
  let warned = false

  function openTask(task) {
    const id = task?.task_id
    if (!jobs || !id || task.ambient === true || open.has(id) || skipped.has(id)) return
    if (settled.has(id) && (!task.run_id || task.run_id === settled.get(id))) return
    const label = task.description || task.command || id
    let resolveDone
    const done = new Promise((resolve) => { resolveDone = resolve })
    const entry = { id, runId: task.run_id ?? '', resolveDone, handle: undefined, confirmTimer: undefined, stopping: false }
    try {
      jobs.start({
        kind: JOB_KIND,
        label,
        ...(session?.id ? { owner: session.id } : {}),
        run(handle) {
          entry.handle = handle
          handle.append(`[Claude Code ${task.task_type ?? 'task'}] ${label}\n`, { channel: 'log' })
          return { cancel: (reason) => requestStop(entry, reason), done }
        },
      })
      open.set(id, entry)
    } catch (error) {
      skipped.add(id)
      if (!warned) {
        warned = true
        ctx?.logger?.warn?.(`claude-driver: could not mirror Claude background task "${label}" as a DSH job: ${String(error?.message ?? error)}`)
      }
    }
  }

  function requestStop(entry, reason) {
    if (entry.stopping) return
    entry.stopping = true
    Promise.resolve()
      .then(() => stopTask?.(entry.id))
      .catch((error) => ctx?.logger?.warn?.(`claude-driver: stopping Claude task ${entry.id} failed: ${String(error?.message ?? error)}`))
    // Claude confirms with a `stopped` notice; if it never does, do not leave the job live.
    entry.confirmTimer = setTimeout(
      () => settle(entry.id, { status: 'killed', detail: reason ? `stop requested (${reason}); Claude Code did not confirm` : 'stop requested; Claude Code did not confirm' }),
      STOP_CONFIRM_MS,
    )
    entry.confirmTimer.unref?.()
  }

  function settle(id, outcome, outputFile) {
    const entry = open.get(id)
    if (!entry) return
    open.delete(id)
    settled.set(id, entry.runId)
    clearTimeout(entry.confirmTimer)
    if (outputFile) {
      const tail = readTail(outputFile)
      if (tail?.text) entry.handle?.append(`${tail.truncated ? '…(earlier output truncated)\n' : ''}${tail.text}${tail.text.endsWith('\n') ? '' : '\n'}`, { channel: 'stdout' })
    }
    entry.resolveDone(outcome)
  }

  return {
    /** Level signal: open jobs for new tasks, settle the ones that left. */
    sync(tasks) {
      if (!jobs) return
      const present = new Set()
      for (const task of tasks ?? []) {
        if (task?.ambient === true) continue
        present.add(task.task_id)
        openTask(task)
      }
      for (const id of [...open.keys()]) {
        if (!present.has(id)) settle(id, { status: 'completed', detail: 'finished; Claude Code sent no completion notice' })
      }
    },
    /** `task_started`: only tasks the CLI says are backgrounded. */
    started(message) {
      if (message?.is_backgrounded === true) openTask(message)
    },
    progress(message) {
      const entry = open.get(message?.task_id)
      if (!entry?.handle) return
      const line = message.summary || (message.last_tool_name ? `using ${message.last_tool_name}` : message.description)
      if (line) entry.handle.updateProgress(String(line))
    },
    notify(message) {
      if (!jobs || message?.ambient === true || !open.has(message?.task_id)) return
      const status = STATUS[message.status] ?? 'failed'
      const summary = typeof message.summary === 'string' ? message.summary.trim() : ''
      if (summary) open.get(message.task_id).handle?.append(`${summary}\n`, { channel: 'log' })
      settle(
        message.task_id,
        { status, ...(firstLine(summary) ? { detail: firstLine(summary) } : {}), ...(summary ? { result: summary } : {}) },
        message.output_file || undefined,
      )
    },
    /** Settle everything still open (the run ended; Claude's process is gone). */
    closeAll(reason) {
      for (const id of [...open.keys()]) settle(id, { status: 'killed', detail: reason })
    },
    get size() {
      return open.size
    },
  }
}
