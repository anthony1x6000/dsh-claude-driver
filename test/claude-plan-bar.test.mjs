// The composer bar shows the session price next to the 5-hour and weekly plan
// windows, in one line like the DSH token-usage bar. The segment logic is pure, so
// it is pinned here against the client bundle, run in a sandbox with a stub React.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'

const source = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => (sandbox.registration = reg) } },
  document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} }, body: {}, addEventListener() {}, querySelectorAll: () => [] },
  Element: class {},
  WeakMap,
  MutationObserver: class {
    observe() {}
  },
  requestAnimationFrame: () => {},
}
vm.runInNewContext(source, sandbox, { filename: 'client/client.js' })
const fakeRequire = () => ({ createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useRef: () => ({ current: null }) })
const { barSegments: barSegmentsInSandbox } = sandbox.registration.factory(fakeRequire)
// Results are built in the sandbox realm; copy them out so deepEqual compares plain data.
const barSegments = (input) => JSON.parse(JSON.stringify(barSegmentsInSandbox(input)))

const windows = (over = {}) => ({ fiveHour: { percent: 42, resetsAt: null }, weekly: { percent: 13.5, resetsAt: null }, ...over })

test('the bar shows the session price, then the 5-hour and weekly windows, rounded', () => {
  const bar = barSegments({ stats: { costUsd: 0.00129 }, snapshot: { ok: true, windows: windows() } })
  assert.equal(bar.cost, '$0.0013')
  assert.deepEqual(
    bar.windows.map(({ label, percent }) => [label, percent]),
    [
      ['5h', 42],
      ['Week', 14],
    ],
  )
})

test('no plan limits (API key) leaves only the price', () => {
  const bar = barSegments({ stats: { costUsd: 1 }, snapshot: { ok: false, code: 'unavailable' } })
  assert.equal(bar.cost, '$1.0000')
  assert.deepEqual(bar.windows, [])
})

test('an unpriced session shows n/a, not a guessed price', () => {
  assert.equal(barSegments({ stats: { costUsd: null }, snapshot: null }).cost, 'n/a')
})

test('no session stats yet means no price segment', () => {
  assert.equal(barSegments({ stats: null, snapshot: { ok: true, windows: windows() } }).cost, null)
})

test('a window that is nearly used up is flagged, a fresh one is not', () => {
  const bar = barSegments({ stats: null, snapshot: { ok: true, windows: windows({ fiveHour: { percent: 92, resetsAt: null }, weekly: { percent: 75, resetsAt: null } }) } })
  assert.deepEqual(
    bar.windows.map(({ label, tone }) => [label, tone]),
    [
      ['5h', 'danger'],
      ['Week', 'warn'],
    ],
  )
})
