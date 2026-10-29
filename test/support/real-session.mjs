// Faithful stand-in for dsh-session's Session: NO `events` array. The log is
// readable only through seq / eventAt(seq) / snapshotEvents(), as in production.
// dsh-session-format v4 rule for tool/result rows (assertV4ToolResultMessage).
export function assertV4ToolResult(event) {
  const m = event.data?.message
  const fail = (why) => { throw new Error(`format v4 tool/result at seq ${event.seq} ${why}`) }
  if (!m || typeof m !== 'object') fail('message must be an object')
  if (typeof m.id !== 'string' || !m.id) fail('requires a first-class message with a string id')
  if (m.role !== 'tool') fail('requires a tool-role message')
  if (typeof m.toolCallId !== 'string' || !m.toolCallId || m.source?.callId !== m.toolCallId) fail('requires toolCallId matching its tool source')
  if (m.source?.kind !== 'tool') fail('requires a tool source')
  if (!Array.isArray(m.content)) fail('requires array content')
  if (m.content.some((b) => b?.type === 'tool-result')) fail('content must not contain a released tool-result wrapper')
  if (m.isError !== undefined && typeof m.isError !== 'boolean') fail('isError must be boolean when present')
}

export function realShapedSession(seed = []) {
  const log = []
  const session = {
    id: 'real-shaped',
    get seq() { return log.length },
    eventAt(seq) { return log[seq] },
    snapshotEvents(from = 0, to = log.length) { return Object.freeze(log.slice(from, to)) },
    append(type, data, opts) {
      if (type === 'tool/result') assertV4ToolResult({ seq: log.length, data })
      const e = { type, seq: log.length, time: 1, data, ...(opts ?? {}) }; log.push(e); return e },
  }
  for (const [type, data, opts] of seed) session.append(type, data, opts)
  return session
}
