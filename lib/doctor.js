// /claude-doctor: what is installed, what is missing, how to fix it.
import { ensureClaudeCli, inspectDeps } from './deps.js'

const mark = (ok) => (ok ? '✓' : '✗')

export function renderDoctorReport(d) {
  const lines = []
  lines.push(`${mark(d.node.ok)} Node ${d.node.version}${d.node.ok ? '' : ' (22.19+ required)'}`)
  lines.push(`${mark(d.sdk.ok)} Claude Agent SDK ${d.sdk.ok ? d.sdk.version : 'missing (reinstall the plugin: dsh plugin add dsh-claude-driver)'}`)
  lines.push(`${mark(d.zod.ok)} zod ${d.zod.ok ? d.zod.version : 'missing (reinstall the plugin)'}`)
  if (d.claude.ok) lines.push(`✓ Claude Code CLI ${d.claude.version ?? ''} (${d.claude.source}: ${d.claude.path})`.replace('  ', ' '))
  else lines.push(`✗ Claude Code CLI missing${d.claude.error ? ` — ${d.claude.error}` : ''}. Run /claude-doctor install, or install it yourself (npm i -g @anthropic-ai/claude-code).`)
  if (d.login.state === 'logged-in') lines.push('✓ Claude account: logged in')
  else if (d.login.state === 'logged-out') lines.push('✗ Claude account: not logged in — run `claude /login` on the DSH host')
  else lines.push('· Claude account: unknown')
  return lines.join('\n')
}

export function createClaudeDoctorCommand({ depsOptions = {}, run, ensureCli = ensureClaudeCli } = {}) {
  return {
    name: 'claude-doctor',
    description: 'Check the Claude Code CLI and the driver\'s dependencies; "install" installs a missing CLI',
    input: { hint: '[install]' },
    async handler(invocation) {
      const arg = String(invocation?.rawInput ?? '').trim()
      if (arg !== '' && arg !== 'install') return { kind: 'error', text: 'Usage: /claude-doctor [install]' }
      const base = { ...depsOptions, ...(run ? { run } : {}) }
      if (arg === 'install') {
        const before = await inspectDeps(base)
        if (before.claude.ok) return { kind: 'success', text: `The Claude Code CLI is already installed (${before.claude.source}: ${before.claude.path}); nothing changed.\n\n${renderDoctorReport(before)}` }
        const r = await ensureCli({ ...base, force: true })
        const after = await inspectDeps({ ...base, checkLogin: true })
        const head = r.action === 'installed' ? `Installed the Claude Code CLI ${r.version ?? ''} at ${r.path}.` : `Install ${r.action}${r.error ? `: ${r.error}` : r.reason ? ` (${r.reason})` : ''}.`
        return { kind: r.action === 'failed' ? 'error' : 'success', text: `${head}\n\n${renderDoctorReport(after)}` }
      }
      return { kind: 'success', text: renderDoctorReport(await inspectDeps({ ...base, checkLogin: true })) }
    },
  }
}
