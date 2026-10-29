// Claude Code built-in tools -> DSH's native tool cards.
//
// DSH renders a tool call from a `tool/call` + `tool/result` session event pair
// keyed by tool NAME (bash, read, write, edit, grep, glob, web_fetch, ...). A
// Claude built-in is mapped onto the DSH twin's name and argument shape so the
// user sees the same card DSH draws for its own tools, instead of narration
// text inside the thinking block. Tools without a twin keep their own name and
// get the generic card.

const MCP_PREFIX = /^mcp__/

const MAPPERS = {
  Bash: (i) => ({
    name: 'bash',
    args: {
      command: i.command,
      description: i.description || String(i.command ?? '').split('\n')[0].slice(0, 120),
      ...(i.timeout !== undefined ? { timeoutMs: i.timeout } : {}),
      ...(i.run_in_background ? { run_in_background: true } : {}),
    },
  }),
  Read: (i) => ({ name: 'read', args: pick(i, ['file_path', 'offset', 'limit']) }),
  Write: (i) => ({ name: 'write', args: pick(i, ['file_path', 'content']) }),
  Edit: (i) => ({ name: 'edit', args: pick(i, ['file_path', 'old_string', 'new_string', 'replace_all']) }),
  Grep: (i) => ({ name: 'grep', args: { pattern: i.pattern, ...(i.path !== undefined ? { path: i.path } : {}), ...(i.glob !== undefined ? { include: i.glob } : {}) } }),
  Glob: (i) => ({ name: 'glob', args: pick(i, ['pattern', 'path']) }),
  WebFetch: (i) => ({ name: 'web_fetch', args: { url: i.url } }),
  WebSearch: (i) => ({ name: 'web_search', args: { queries: [i.query] } }),
}

function pick(input, keys) {
  const out = {}
  for (const key of keys) if (input?.[key] !== undefined) out[key] = input[key]
  return out
}

/**
 * The DSH card (tool name + arguments) for a Claude built-in tool call.
 * @returns undefined for MCP tools, which are not built-ins.
 */
export function dshCardFor(toolName, input) {
  if (typeof toolName !== 'string' || MCP_PREFIX.test(toolName)) return undefined
  const safe = input && typeof input === 'object' ? input : {}
  const mapper = MAPPERS[toolName]
  return mapper ? mapper(safe) : { name: toolName, args: safe }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part?.type === 'text' ? part.text : '')).join('\n')
  return ''
}

/** Result content for a card, with the exit marker DSH's terminal card reads. */
export function resultContentFor(dshName, content, isError) {
  const body = textOf(content)
  const text = dshName === 'bash' ? `${body}\n[exit code: ${isError ? 1 : 0}]` : body
  return [{ type: 'text', text }]
}
