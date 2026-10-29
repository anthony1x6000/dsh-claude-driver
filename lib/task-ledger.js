// Which Claude Code task events are worth reporting as a "background task"
// outcome. Shared by the main-model loop and the subagent provider so the two
// can never disagree.
//
// Real CLI behaviour (SDK 0.3.312, measured):
//   * a Bash call that merely runs long raises task_started{is_backgrounded:false}
//     and later task_notification{failed} on a non-zero exit; the call is already
//     its own card with the exit code, so it is NOT a background task;
//   * a subagent's inner tasks carry parent_task_id and belong to the subagent;
//   * the CLI may repeat a notification (resume, replay).
// Only a top-level task that was backgrounded (or listed in the live background
// set) is reported, once.

export function createTaskLedger() {
  const foreground = new Set()
  const background = new Set()
  const reported = new Set()
  const erroredCalls = new Set() // tool_use ids whose own tool_result was an error
  return {
    /** A tool_result passed by: an errored call has already told the user. */
    toolResult(toolUseId, isError) {
      if (toolUseId && isError === true) erroredCalls.add(toolUseId)
    },
    /** `background_tasks_changed`: the live set (callers pass the ambient-filtered list). */
    level(tasks) {
      for (const task of tasks ?? []) if (task?.task_id && !task.parent_task_id) background.add(task.task_id)
    },
    started(message) {
      if (!message?.task_id) return
      if (message.is_backgrounded === true) {
        if (!message.parent_task_id) background.add(message.task_id)
      } else {
        foreground.add(message.task_id)
      }
    },
    /**
     * `task_notification`: the outcome to record, or undefined when it must not
     * be reported. `driverStopping` marks a stop the driver itself caused.
     */
    notification(message, { driverStopping = false } = {}) {
      const id = message?.task_id
      if (!id || message.ambient === true || message.parent_task_id) return undefined
      if (foreground.has(id) || !background.has(id) || reported.has(id)) return undefined
      // The call that spawned this task already returned an error (e.g. "Exit code 143"):
      // that card is the report; a second "background task failed" is the same event twice.
      if (message.status === 'failed' && message.tool_use_id && erroredCalls.has(message.tool_use_id)) return undefined
      reported.add(id)
      return {
        taskId: id,
        status: message.status,
        summary: typeof message.summary === 'string' ? message.summary : '',
        byDriver: driverStopping && message.status === 'stopped',
      }
    },
  }
}
