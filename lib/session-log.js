// Reading a DSH Session's event log.
//
// Production Sessions (dsh-session) expose the log only through `seq`,
// `eventAt(seq)` and `snapshotEvents()`; there is no `events` array. Test
// doubles often carry a plain `events` array. Every read in this driver goes
// through here so both shapes work, and the real one is what tests mirror.

export function readSessionEvents(session) {
  if (!session) return []
  if (Array.isArray(session.events)) return session.events
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
    if (typeof session.eventAt === 'function' && Number.isInteger(session.seq)) {
      const out = []
      for (let seq = 0; seq < session.seq; seq += 1) out.push(session.eventAt(seq))
      return out.filter(Boolean)
    }
  } catch {
    // an unreadable log reads as empty: callers degrade, never throw
  }
  return []
}

/** The most recent event of `type`, or undefined. */
export function lastEvent(session, type) {
  const events = readSessionEvents(session)
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i]?.type === type) return events[i]
  return undefined
}
