// When Claude's supportedModels() discovery fails, the picker quietly falls back to
// the bare aliases (fable/sonnet/opus/haiku). The failure must reach the DSH log
// with its reason, so a regression in the picker can be diagnosed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withDiscoveryWarning } from '../lib/model-catalog.js'

test('a successful discovery passes its model list through unchanged, with no warning', async () => {
  const warnings = []
  const infos = [{ value: 'sonnet', displayName: 'Sonnet 5.5' }]
  const discover = withDiscoveryWarning(async () => infos, { warn: (...args) => warnings.push(args) })
  assert.deepEqual(await discover(), infos)
  assert.deepEqual(warnings, [])
})

test('a failed discovery warns with the reason and still rejects, so the fallback applies', async () => {
  const warnings = []
  const discover = withDiscoveryWarning(
    async () => {
      throw new Error('claude-agent-sdk query has no supportedModels()')
    },
    { warn: (...args) => warnings.push(args) },
  )
  await assert.rejects(discover, /no supportedModels/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /model discovery failed/)
  assert.match(warnings[0][0], /no supportedModels/)
})

test('no discovery function means nothing to wrap', () => {
  assert.equal(withDiscoveryWarning(undefined, { warn() {} }), undefined)
})

test('a missing logger never turns a failure into a different error', async () => {
  const discover = withDiscoveryWarning(async () => {
    throw new Error('boom')
  }, undefined)
  await assert.rejects(discover, /boom/)
})
