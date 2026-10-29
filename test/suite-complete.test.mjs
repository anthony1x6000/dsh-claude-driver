// Every test file in test/ must be run by `npm test` (and so by CI). A file that
// exists but is not wired runs nowhere: it protects nothing and reports nothing.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test
const wired = new Set([...script.matchAll(/(?:test\/)?([\w.-]+\.(?:test\.)?mjs)/g)].map((m) => m[1]))

test('every test/*.test.mjs is run by npm test', () => {
  const missing = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.mjs') && !wired.has(f))
  assert.deepEqual(missing, [], `not wired into "npm test": ${missing.join(', ')}`)
})

test('every top-level test-*.mjs that needs no network or login is run by npm test', () => {
  const live = new Set(['test-run.mjs', 'test-resume-smoke.mjs', 'test-subagent-provider.mjs', 'test-thinking-stream.mjs'])
  const missing = readdirSync(root).filter((f) => /^test-.*\.mjs$/.test(f) && !live.has(f) && !wired.has(f))
  assert.deepEqual(missing, [], `not wired into "npm test": ${missing.join(', ')}`)
})
