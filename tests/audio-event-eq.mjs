// Observe #83: per-event EQ — adding filter params to an event flows through
// the editor (spec land in audioLive, response canvas paints) and the bus
// (filter chain built per voice on play). Loops-EQ + freq response was
// proven in #81; this test focuses on the event-specific bits.
import { chromium } from 'playwright'

const URL = 'http://localhost:7001/edit/levels/lvl_1/audio'
const KEY = 'footstep'

const results = []
const ok = (label, cond, detail = '') => results.push({ label, pass: !!cond, detail })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!(window).__audioBus, null, { timeout: 15000 })
await page.waitForTimeout(1000)

// Lock selection so the live scene's axis_rotation publishes can't steal
// the Inspector mid-test. Then click the footstep row.
await page.evaluate(() => {
  const cb = [...document.querySelectorAll('input[type="checkbox"]')]
    .find(c => c.parentElement?.textContent?.includes('Lock selection'))
  if (cb && !(cb).checked) (cb).click()
})
await page.waitForTimeout(200)
await page.evaluate(() => {
  const row = [...document.querySelectorAll('div')].find(d => {
    const c = d.children
    return c.length === 2 && c[0]?.tagName === 'SPAN' && c[1]?.tagName === 'SPAN'
        && c[0].textContent === 'EVT' && c[1].textContent === 'footstep'
  })
  row?.click()
})
await page.waitForTimeout(500)

const inspKey = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Replace sample…')
  let pane = btn?.parentElement
  while (pane && pane.parentElement && getComputedStyle(pane).overflowY !== 'auto') pane = pane.parentElement
  return pane?.children?.[0]?.textContent?.trim().replace(/Reset to default$/, '') ?? null
})
ok('Inspector showing footstep (event)', inspKey === KEY, `got ${inspKey}`)

// 1. Initially no params.
const before = await page.evaluate((k) => (window).__audioBus.getEventFilterNames(k), KEY)
ok('before: no EQ bands on event', before.length === 0, `chain=${JSON.stringify(before)}`)

// 2. Add a peaking band via setEventParamSpec.
await page.evaluate((k) => {
  (window).__audioBus.setEventParamSpec(k, 'peaking', { base: 1000, gain: 12, q: 2 })
}, KEY)
await page.waitForTimeout(150)

const afterNames = await page.evaluate((k) => (window).__audioBus.getEventFilterNames(k), KEY)
ok('after setEventParamSpec: peaking in event filter list',
   afterNames.includes('peaking'), `chain=${JSON.stringify(afterNames)}`)

const spec = await page.evaluate((k) => (window).__audioBus.getEventRuntimeDef(k)?.params?.peaking, KEY)
ok('peaking spec persisted on event def: gain 12 dB @ 1000 Hz, Q=2',
   spec?.base === 1000 && spec?.gain === 12 && spec?.q === 2, `got ${JSON.stringify(spec)}`)

// 3. Stack a lowshelf -6 dB — verify multi-band stacks.
await page.evaluate((k) => {
  (window).__audioBus.setEventParamSpec(k, 'lowshelf', { base: 200, gain: -6 })
}, KEY)
await page.waitForTimeout(150)
const stacked = await page.evaluate((k) => (window).__audioBus.getEventFilterNames(k), KEY)
ok('after add lowshelf: event chain has BOTH peaking + lowshelf',
   stacked.includes('peaking') && stacked.includes('lowshelf'), `chain=${JSON.stringify(stacked)}`)

// 4. FrequencyResponseCanvas paints a curve when the event has EQ.
//    Wait for ParamsEditor's heartbeat re-render to repaint the canvas.
await page.waitForTimeout(1200)
const canvasInfo = await page.evaluate(() => {
  const header = [...document.querySelectorAll('div')].find(d => d.textContent?.trim() === 'Frequency response')
  if (!header) return { found: false, reason: 'no label' }
  const canvas = header.parentElement?.querySelector('canvas')
  if (!(canvas instanceof HTMLCanvasElement)) return { found: false, reason: 'no canvas' }
  const ctx = canvas.getContext('2d')
  if (!ctx) return { found: false, reason: 'no 2d ctx' }
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let curvePixels = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
    if (a > 0 && r > 80 && r < 180 && g > 130 && g < 200 && b > 200) curvePixels++
  }
  return { found: true, curvePixels }
})
ok('FrequencyResponseCanvas paints a curve for the event',
   canvasInfo.found && canvasInfo.curvePixels > 10, `info=${JSON.stringify(canvasInfo)}`)

await browser.close()

console.log('\n=== per-event EQ observation ===\n')
let allPass = true
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.label}${!r.pass && r.detail ? '  (' + r.detail + ')' : ''}`)
  if (!r.pass) allPass = false
}
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
