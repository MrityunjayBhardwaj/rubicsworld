// Observe #81: adding EQ bands (lowshelf / peaking / highshelf) via the
// editor wires real BiquadFilterNodes into the loop's audible chain AND
// updates the frequency-response canvas.
//
// Targets whatever loop the Inspector currently shows (the editor may
// auto-select the axis_rotation rumble loop on boot via #78) so the
// canvas assertion reflects the same sound we edit.
//
// Two observations:
//   A) After setLoopParamSpec for a NEW filter type, the chain rebuild
//      happens — getLoopFilterNames(key) includes the new type. Proves
//      the latent #54 gap is closed (pre-fix, adding a filter was a
//      silent no-op until reload).
//   B) The FrequencyResponseCanvas paints a non-empty blue curve once an
//      EQ band is active.
import { chromium } from 'playwright'

const URL = 'http://localhost:7003/edit/levels/lvl_1/audio'

const results = []
const ok = (label, cond, detail = '') => results.push({ label, pass: !!cond, detail })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!(window).__audioBus, null, { timeout: 15000 })
await page.waitForTimeout(1000)

// The live scene in the editor keeps auto-selecting axis_rotation (the
// rotation rumble publishes to lastTriggered — #78). Lock selection so the
// Inspector stays put on whatever's shown, making the canvas assertion
// deterministic.
await page.evaluate(() => {
  const cb = [...document.querySelectorAll('input[type="checkbox"]')]
    .find(c => c.parentElement?.textContent?.includes('Lock selection'))
  if (cb && !(cb).checked) (cb).click()
})
await page.waitForTimeout(700)

// Read the loop key the Inspector is currently showing (its first child div).
const selectedKey = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Replace sample…')
  let pane = btn?.parentElement
  while (pane && pane.parentElement && getComputedStyle(pane).overflowY !== 'auto') pane = pane.parentElement
  // strip the trailing "Reset to default" button text the header row carries
  return pane?.children?.[0]?.textContent?.trim().replace(/Reset to default$/, '') ?? null
})
ok('Inspector is showing a loop', !!selectedKey && /^[a-z_]+$/.test(selectedKey), `key=${selectedKey}`)

// Make sure the loop is registered so the chain rebuild has a node.
await page.evaluate((k) => {
  const b = (window).__audioBus
  const def = b.getLoopRuntimeDef(k)
  if (def) b.registerLoop(def)
}, selectedKey)
await page.waitForTimeout(400)

// --- A) chain rebuild on add ---
const beforeNames = await page.evaluate((k) => (window).__audioBus.getLoopFilterNames(k), selectedKey)
ok('before: peaking not in chain', !beforeNames.includes('peaking'), `chain=${JSON.stringify(beforeNames)}`)

await page.evaluate((k) => {
  (window).__audioBus.setLoopParamSpec(k, 'peaking', { base: 1000, gain: 12, q: 2 })
}, selectedKey)
await page.waitForTimeout(200)

const afterNames = await page.evaluate((k) => (window).__audioBus.getLoopFilterNames(k), selectedKey)
ok('after add peaking: chain rebuilt to include it', afterNames.includes('peaking'), `chain=${JSON.stringify(afterNames)}`)

const spec = await page.evaluate((k) => (window).__audioBus.getLoopRuntimeDef(k)?.params?.peaking, selectedKey)
ok('peaking spec persisted: gain 12 dB @ 1000 Hz, Q=2',
   spec?.base === 1000 && spec?.gain === 12 && spec?.q === 2, `got ${JSON.stringify(spec)}`)

await page.evaluate((k) => {
  (window).__audioBus.setLoopParamSpec(k, 'lowshelf', { base: 200, gain: -6 })
}, selectedKey)
await page.waitForTimeout(200)
const stackedNames = await page.evaluate((k) => (window).__audioBus.getLoopFilterNames(k), selectedKey)
ok('after add lowshelf: chain has BOTH peaking + lowshelf',
   stackedNames.includes('peaking') && stackedNames.includes('lowshelf'), `chain=${JSON.stringify(stackedNames)}`)

// --- B) FrequencyResponseCanvas paints a curve ---
// Wait through a couple of the workspace's 500ms heartbeats so ParamsEditor
// re-reads the now-EQ'd params and repaints the canvas.
await page.waitForTimeout(1200)
const canvasInfo = await page.evaluate(() => {
  const header = [...document.querySelectorAll('div')].find(d => d.textContent?.trim() === 'Frequency response')
  if (!header) return { found: false, reason: 'no Frequency response label' }
  const canvas = header.parentElement?.querySelector('canvas')
  if (!(canvas instanceof HTMLCanvasElement)) return { found: false, reason: 'no canvas in section' }
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
ok('FrequencyResponseCanvas painted a non-empty curve',
   canvasInfo.found && canvasInfo.curvePixels > 10, `info=${JSON.stringify(canvasInfo)}`)

await browser.close()

console.log('\n=== 3-band EQ observation ===\n')
let allPass = true
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.label}${!r.pass && r.detail ? '  (' + r.detail + ')' : ''}`)
  if (!r.pass) allPass = false
}
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
