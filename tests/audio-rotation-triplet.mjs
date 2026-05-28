// Observe #87: axis rotation now fires a triplet —
//   axis_rotation_start (one-shot, rising edge of drag||anim)
//   axis_rotation       (sustain loop, modulator-driven, unchanged)
//   axis_rotation_end   (one-shot, falling edge)
//
// Spies on audioBus.play to capture which event keys fire, then drives
// state.drag truthy/null to cross both edges. Once per gesture — the
// rising-edge guard (prevSliceActive) is the load-bearing bit; if it
// regressed the test would log dozens of starts on a single drag.
//
// Scoped to wiring observation (which keys fire, in what order) — not
// audio output. Audible verification is sound-design work the user
// does via SampleSwap in the editor.
import { chromium } from 'playwright'

const URL = 'http://localhost:7001/edit/levels/lvl_1/audio'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!(window).__planet && !!(window).__audioBus, null, { timeout: 15000 })

// Spy on play() before any user interaction so we catch the very first
// trigger. Push keys into an array we can drain from Node.
await page.evaluate(() => {
  const bus = (window).__audioBus
  const calls = []
  ;(window).__playCalls = calls
  const orig = bus.play.bind(bus)
  bus.play = (key, opts) => { calls.push(key); return orig(key, opts) }
})

await page.waitForTimeout(400)

// Gesture 1: drag truthy → drag null. Crosses rising edge then falling edge.
await page.evaluate(() => {
  (window).__planet.setState({ drag: { axis: 'x', start: 0, slice: 0 } })
})
await page.waitForTimeout(200)
await page.evaluate(() => {
  (window).__planet.setState({ drag: null })
})
await page.waitForTimeout(200)

const firstGesture = await page.evaluate(() => (window).__playCalls.slice())

// Gesture 2: a second drag should fire the triplet again (no sticky state).
await page.evaluate(() => { (window).__playCalls.length = 0 })
await page.evaluate(() => {
  (window).__planet.setState({ drag: { axis: 'y', start: 0, slice: 1 } })
})
await page.waitForTimeout(200)
await page.evaluate(() => {
  (window).__planet.setState({ drag: null })
})
await page.waitForTimeout(200)

const secondGesture = await page.evaluate(() => (window).__playCalls.slice())

await browser.close()

const starts1 = firstGesture.filter(k => k === 'axis_rotation_start').length
const ends1   = firstGesture.filter(k => k === 'axis_rotation_end').length
const starts2 = secondGesture.filter(k => k === 'axis_rotation_start').length
const ends2   = secondGesture.filter(k => k === 'axis_rotation_end').length

const startIdx1 = firstGesture.indexOf('axis_rotation_start')
const endIdx1   = firstGesture.indexOf('axis_rotation_end')
const orderOk   = startIdx1 !== -1 && endIdx1 !== -1 && startIdx1 < endIdx1

console.log('\n=== axis rotation triplet observation ===\n')
console.log('  gesture 1 play() calls:', JSON.stringify(firstGesture))
console.log('  gesture 2 play() calls:', JSON.stringify(secondGesture))
console.log()
const ok1 = starts1 === 1
const ok2 = ends1 === 1
const ok3 = orderOk
const ok4 = starts2 === 1 && ends2 === 1
console.log(`  ${ok1 ? '✓' : '✗'} gesture 1: axis_rotation_start fired exactly once  (got ${starts1})`)
console.log(`  ${ok2 ? '✓' : '✗'} gesture 1: axis_rotation_end   fired exactly once  (got ${ends1})`)
console.log(`  ${ok3 ? '✓' : '✗'} gesture 1: start fires BEFORE end`)
console.log(`  ${ok4 ? '✓' : '✗'} gesture 2: triplet repeats on a fresh drag         (start ${starts2}, end ${ends2})`)
const allPass = ok1 && ok2 && ok3 && ok4
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
