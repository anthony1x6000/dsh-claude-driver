// Carries DSH's permission state into Claude Code.
//
// DSH keeps two independent knobs per session: the sandbox mode
// (`sandbox/mode`) and the approval policy (`approval/policy`); the "full
// access" preset is `danger-full-access` + `never`. Claude Code has its own
// permission mode. Without this module the driver always spawned Claude with a
// fixed `acceptEdits`, so a session the user had opened to full access still
// made Claude refuse anything beyond file edits.
//
// Mapping (the sandbox mode decides what Claude may touch; the approval policy
// only decides who is asked, and the CLI has no interactive surface here):
//   danger-full-access -> bypassPermissions (+ the SDK's opt-in flag)
//   workspace-write    -> acceptEdits
//   read-only          -> plan
// An explicit `permissionMode` in the driver config always wins, and
// `followDshPermissions: false` restores the fixed legacy default.

export const FALLBACK_PERMISSION_MODE = 'acceptEdits'

const BY_SANDBOX = {
  'danger-full-access': 'bypassPermissions',
  'workspace-write': 'acceptEdits',
  'read-only': 'plan',
}

/**
 * Claude Code permission settings for a DSH permission state.
 * @param dsh - `{ sandbox?, approval? }` as read from DSH.
 * @returns the SDK `permissionMode`, plus the opt-in flag bypass mode requires.
 */
export function claudePermissionsFor(dsh) {
  const permissionMode = BY_SANDBOX[dsh?.sandbox] ?? FALLBACK_PERMISSION_MODE
  return permissionMode === 'bypassPermissions'
    ? { permissionMode, allowDangerouslySkipPermissions: true }
    : { permissionMode }
}

function lastEventData(session, type, key) {
  const events = session?.events
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === type) return events[i]?.data?.[key]
  }
  return undefined
}

/**
 * The session whose permissions apply to the turn being started: the
 * initiating agent's. Undefined outside a DSH agent (tests, standalone).
 * @param ctx - the plugin context.
 */
export function currentSession(ctx) {
  try {
    return ctx?.get?.('agents')?.currentInitiator?.()?.session
  } catch {
    return undefined
  }
}

/**
 * Read DSH's effective sandbox mode and approval policy for a session. The
 * mounted services are authoritative; the session log is the fallback when a
 * service is absent. A knob DSH cannot report stays undefined.
 * @param ctx - the plugin context.
 * @param session - the DSH session to read.
 * @returns `{ sandbox?, approval? }`.
 */
export function readDshPermissions(ctx, session) {
  if (!session) return {}
  let sandbox
  let approval
  try {
    sandbox = ctx?.get?.('sandboxPolicy')?.resolve?.({ session })?.mode
  } catch {
    // service present but unusable — fall back to the log
  }
  try {
    approval = ctx?.get?.('approval')?.overrideOf?.(session)
  } catch {
    // same
  }
  sandbox ??= lastEventData(session, 'sandbox/mode', 'mode')
  approval ??= lastEventData(session, 'approval/policy', 'policy')
  return { ...(sandbox ? { sandbox } : {}), ...(approval ? { approval } : {}) }
}

/**
 * Decide the Claude permission settings for one spawn.
 * @param ctx - the plugin context.
 * @param settings - the driver settings.
 * @param session - the DSH session the turn belongs to, if any.
 * @returns `{ permissionMode, allowDangerouslySkipPermissions?, source, dsh }`
 *   where `source` is `config`, `dsh`, or `default`.
 */
export function resolvePermissions(ctx, settings, session) {
  if (typeof settings?.permissionMode === 'string' && settings.permissionMode) {
    const permissionMode = settings.permissionMode
    return {
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      source: 'config',
      dsh: {},
    }
  }
  if (settings?.followDshPermissions === false) {
    return { permissionMode: FALLBACK_PERMISSION_MODE, source: 'default', dsh: {} }
  }
  const dsh = readDshPermissions(ctx, session)
  return { ...claudePermissionsFor(dsh), source: dsh.sandbox ? 'dsh' : 'default', dsh }
}
