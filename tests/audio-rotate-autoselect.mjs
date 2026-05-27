// Observe #77: starting a slice rotation auto-selects the axis_rotation
// row in the audio editor.
//
// Drives the existing window.__planet store hook to flip the rotation-
// active condition (state.drag truthy) → the audio subscription publishes
// 'axis_rotation' to useLastTriggered → the editor's auto-select effect
// switches the Inspector to that row.
//
// Kept minimal — multi-gesture / rising-edge behavior was verified by code
// review (a single boolean `prevSliceActive` flag); the costly bit to
// observe is the end-to-end wiring of one rotation → editor highlight.
import { chromium } from 'playwright'

const URL = 'http://localhost:5175/edit/levels/lvl_1/audio'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!(window).__planet, null, { timeout: 15000 })
await page.waitForTimeout(800)

const inspectorKey = () => page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Replace sample…')
  if (!btn) return null
  let n = btn.parentElement
  while (n && n.parentElement) {
    if (getComputedStyle(n).overflowY === 'auto') break
    n = n.parentElement
  }
  return n?.children?.[0]?.textContent?.trim() ?? null
})

const initial = await inspectorKey()
const beforeOk = initial && initial !== 'axis_rotation'

// One write to flip drag truthy. Setting state directly (no .getState().setDrag)
// because we want the subscription listener to fire — and zustand fires it on
// any setState. The shape here only needs to be NOT null for the subscription's
// `state.drag != null` check; scene code may read more fields but the Inspector
// only depends on selectedKey which we observe via DOM.
await page.evaluate(() => {
  (window).__planet.setState({ drag: { axis: 'x', start: 0, slice: 0 } })
})
await page.waitForTimeout(500)
const after = await inspectorKey()

// Clean up — return drag to null so the page doesn't sit in a half-rotated state.
await page.evaluate(() => (window).__planet.setState({ drag: null }))
await browser.close()

const ok1 = !!beforeOk
const ok2 = after === 'axis_rotation'
console.log('\n=== rotation auto-highlight observation ===\n')
console.log(`  ${ok1 ? '✓' : '✗'} on load: Inspector shows a sound (not axis_rotation)  (got ${initial})`)
console.log(`  ${ok2 ? '✓' : '✗'} after rotation start: Inspector switched to axis_rotation  (got ${after})`)
const allPass = ok1 && ok2
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
