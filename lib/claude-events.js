// Claude Code -> DSH: one-line notes for events Claude raises while working.
// Driver narration only: never counted as the model's answer.

const k = (n) => (Number.isFinite(n) && n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? '?'))

function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

/**
 * The "still working" line for a quiet gap. `activity` is what Claude is
 * doing right now ({name, subject}) or undefined while it is just thinking.
 */
export function renderPulse(pulse, activity) {
  const doing = activity ? `${activity.name}${activity.subject ? `: ${activity.subject}` : ''}` : 'thinking, waiting for Claude'
  return `\n· still working ${duration(pulse?.elapsedMs)} — ${doing}\n`
}

export function renderClaudeEventNote(msg) {
  if (msg?.type !== 'system') return ''
  switch (msg.subtype) {
    case 'api_retry':
      // The first retry is routine; from the second on the user is waiting on it.
      return msg.attempt >= 2
        ? `\n· Anthropic API retry ${msg.attempt}/${msg.max_retries ?? '?'}${msg.error_status ? ` (status ${msg.error_status})` : ''}\n`
        : ''
    case 'status':
      return msg.status === 'compacting' ? '\n· Claude is compacting its context…\n' : ''
    case 'permission_denied':
      return `\n[Claude Code] ${msg.tool_name} was denied${msg.decision_reason ? `: ${msg.decision_reason}` : ''}\n`
    case 'model_refusal_fallback':
      return `\n[Claude Code] ${msg.original_model} declined; ${msg.direction === 'revert' ? 'reverted to' : 'retried with'} ${msg.fallback_model}\n`
    case 'notification':
      return msg.text ? `\n[Claude Code] ${msg.text}\n` : ''
    case 'compact_boundary': {
      const m = msg.compact_metadata ?? {}
      return `\n[Claude Code] compacted its context (${m.trigger ?? 'auto'}): ${m.pre_tokens} → ${m.post_tokens ?? '?'} tokens (${k(m.pre_tokens)} → ${k(m.post_tokens)})\n`
    }
    default:
      return ''
  }
}
