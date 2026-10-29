// The catalog adapter must answer every method DSH's LlmRuntime calls on an
// adapter. Missing one is a hard runtime crash (e.g. /compact failed with
// "adapter.imageRequestPricing is not a function"). When DSH_LLM_TYPES points at
// a released @deepseek-ai/dsh-llm `lib/types/index.d.ts`, the method list is read
// from that release, so a new DSH method fails CI before users hit it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createClaudeCodeAdapter } from '../lib/model-catalog.js'

const KNOWN = ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'imageRequestTarget', 'listModels', 'resolveModel', 'prepareCall', 'stream']

export function adapterMethodsFromTypes(dts) {
  const start = dts.search(/(?:export )?declare abstract class LlmAdapter \{|export abstract class LlmAdapter \{/)
  assert.ok(start >= 0, 'LlmAdapter class declaration found')
  let depth = 0
  let end = start
  for (let i = dts.indexOf('{', start); i < dts.length; i += 1) {
    if (dts[i] === '{') depth += 1
    else if (dts[i] === '}' && --depth === 0) { end = i; break }
  }
  const body = dts.slice(dts.indexOf('{', start) + 1, end).replace(/\/\*[\s\S]*?\*\//g, '')
  return [...body.matchAll(/^\s*(?:abstract\s+)?(?:async\s+)?([a-zA-Z]\w*)\s*\(/gm)].map((m) => m[1]).filter((n) => n !== 'constructor')
}

const adapter = createClaudeCodeAdapter({ provider: 'claude-code', effort: 'medium', autoDiscoverModels: false })
const image = { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 1234, width: 640, height: 480 }

test('every LlmAdapter method DSH may call exists', () => {
  const required = process.env.DSH_LLM_TYPES ? adapterMethodsFromTypes(readFileSync(process.env.DSH_LLM_TYPES, 'utf8')) : KNOWN
  if (process.env.DSH_LLM_TYPES) console.log(`checking against released LlmAdapter: ${required.join(', ')}`)
  for (const method of required) assert.equal(typeof adapter[method], 'function', `adapter.${method} missing`)
})

test('imageRequestPricing answers synchronously with no pricing (meter uses its neutral estimate)', () => {
  assert.equal(adapter.imageRequestPricing('claude-code', 'sonnet'), undefined)
})

test('imageRequestTarget preserves the normalized image', () => {
  assert.deepEqual(adapter.imageRequestTarget('claude-code', 'sonnet', image), { width: 640, height: 480, maxBytes: 1234 })
})

test('the parser reads method names from a real-shaped declaration', () => {
  const dts = 'export declare abstract class LlmAdapter {\n    /** doc */\n    providerInfo(provider: string): X;\n    imageRequestPricing(_p: string, _m: string): Y | undefined;\n    prepareCall(p: string): Promise<Z>;\n    abstract stream(options: G): AsyncIterable<S>;\n}\nexport declare class Other { nope(): void }'
  assert.deepEqual(adapterMethodsFromTypes(dts), ['providerInfo', 'imageRequestPricing', 'prepareCall', 'stream'])
})
