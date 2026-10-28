// Minimal Anthropic Messages API double (SSE). `script(requestBody, n)` returns
// the content blocks for the nth request: {text} | {tool_use:{id,name,input}}.
import http from 'node:http'

export async function startMockAnthropic(script) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      let body = {}
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      requests.push(body)
      const blocks = script(body, requests.length)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      send('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-5', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } })
      blocks.forEach((block, index) => {
        if (block.tool_use) {
          send('content_block_start', { index, content_block: { type: 'tool_use', id: block.tool_use.id, name: block.tool_use.name, input: {} } })
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.tool_use.input) } })
        } else {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } })
          send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
        }
        send('content_block_stop', { index })
      })
      send('message_delta', { delta: { stop_reason: blocks.some((b) => b.tool_use) ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } })
      send('message_stop', {})
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
  return {
    // 127.0.0.2: loopback, but NOT in the driver's NO_PROXY, so proxy settings apply to it.
    url: `http://127.0.0.2:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

// A port that is guaranteed to have no listener (bind, note, release).
export async function deadPort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}
