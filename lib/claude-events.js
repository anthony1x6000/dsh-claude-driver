// Claude Code -> DSH: one-line notes for events Claude raises while working.
// Driver narration only: never counted as the model's answer.

const k = (n) => (Number.isFinite(n) && n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? '?'))

export function renderClaudeEventNote(msg) {
  if (msg?.type !== 'system') return ''
  switch (msg.subtype) {
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
