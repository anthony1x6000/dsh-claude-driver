// A bridged DSH tool whose result carries an image (`read_image`) must hand
// Claude the pixels. The MCP boundary carries image content natively, so the
// bridge resolves the attachment reference to base64 bytes instead of
// flattening it to JSON metadata — the old flattening is why Claude never saw
// the image and had to fall back to its own `Read`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildToolBridge } from '../lib/index.js'

// 1x1 transparent PNG; the bytes are never decoded here, only carried.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: PNG.byteLength, width: 1, height: 1, name: 'shot.png' }
const readImageResult = [
  { type: 'text', text: '<path>/home/x/shot.png</path>' },
  { type: 'image', attachment: ref },
]
const agent = { id: 'a' }
const schema = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })

function bridgeFor(result, attachments) {
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) =>
      name === 'tools'
        ? { execute: async (batch) => ({ results: batch.calls.map((call) => ({ callId: call.id, result })), additionalContexts: [], concluded: false }) }
        : name === 'agents'
          ? { currentInitiator: () => agent }
          : name === 'attachments'
            ? attachments
            : undefined,
  }
  const options = { provider: 'claude-code', model: 'sonnet', messages: [], tools: [schema('read_image')] }
  return buildToolBridge(ctx, options, { model: 'sonnet', nativeToolCards: false }, new AbortController())
}

test('read_image is bridged: Claude gets the tool that returns pixels', () => {
  const bridge = bridgeFor({ content: [] }, undefined)
  assert.ok(bridge.bridgedNames.has('read_image'), 'read_image is advertised to Claude')
  assert.ok(bridge.handlers.has('read_image'), 'a handler executes it')
})

test('a bridged image result reaches Claude as image content, not JSON text', async () => {
  const attachments = {
    readImage: async (attachment, signal) => {
      assert.deepEqual(attachment, ref, 'the attachment reference is resolved verbatim')
      assert.equal(signal instanceof AbortSignal, true, 'the run abort signal is forwarded')
      return { ref, data: PNG }
    },
  }
  const bridge = bridgeFor({ content: readImageResult }, attachments)
  const out = await bridge.handlers.get('read_image')({ file_path: '/home/x/shot.png' })
  assert.deepEqual(
    out.content.map((block) => block.type),
    ['text', 'image'],
    'the text envelope stays beside the image',
  )
  assert.deepEqual(out.content[1], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' })
  assert.equal(out.isError, false)
})

test('an unresolvable image degrades to text instead of failing the tool call', async () => {
  const thrown = bridgeFor({ content: readImageResult }, {
    readImage: async () => {
      throw new Error('ATTACHMENT_NOT_FOUND')
    },
  })
  const out = await thrown.handlers.get('read_image')({ file_path: '/home/x/shot.png' })
  assert.deepEqual(out.content.map((block) => block.type), ['text'], 'no image block survives')
  assert.match(out.content[0].text, /\[image:/, 'the placeholder names the lost image')

  const absent = bridgeFor({ content: readImageResult }, undefined)
  const fallback = await absent.handlers.get('read_image')({ file_path: '/home/x/shot.png' })
  assert.deepEqual(fallback.content.map((block) => block.type), ['text'])
  assert.match(fallback.content[0].text, /\[image:/)
})

test('a text-only result is unchanged and an empty result is still a text block', async () => {
  const bridge = bridgeFor({ content: [{ type: 'text', text: 'ok' }] }, undefined)
  assert.deepEqual(await bridge.handlers.get('read_image')({}), {
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  })

  const empty = bridgeFor({ content: [] }, undefined)
  const out = await empty.handlers.get('read_image')({})
  assert.deepEqual(out.content.map((block) => block.text), ['(no output)'])
})
