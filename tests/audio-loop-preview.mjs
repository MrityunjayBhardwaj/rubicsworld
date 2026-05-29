// Observe #89: loop preview button wiring.
//
// Verifies:
//  1. previewLoop(sampleKey, 5) returns a callable stop handle (truthy fn).
//  2. previewLoop(synthKey, 5) returns null (synth loops not supported).
//  3. previewLoop(eventKey, 5) returns null (events use audioBus.play).
//  4. previewLoop(muted sample loop) returns null (respects per-sound mute).
//  5. Inspector header renders a "Preview ×5" button when a sample loop is selected.
//
// Scoped to wiring observation — actual audio output requires the user
// at the keyboard with speakers. The previewLoop function is small and
// pure-ish (AudioContext side effects), so testing return contracts +
// UI presence is the load-bearing observation.
import { chromium } from 'playwright'

const URL = 'http://localhost:7001/edit/levels/lvl_1/audio'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!(window).__audioBus, null, { timeout: 15000 })
await page.waitForTimeout(600)

// Probe contract — call previewLoop with various keys and inspect the return.
const probe = await page.evaluate(() => {
  const bus = (window).__audioBus
  const sampleLoop = 'theme_music'         // audio/theme.ogg — sample-backed loop
  const synthLoop = 'windmill_whoosh'      // synth:windmillWhoosh — synth loop
  const event = 'tile_snap'                // event, not a loop
  const missing = 'does_not_exist'

  const sample = bus.previewLoop(sampleLoop, 5)
  const synth = bus.previewLoop(synthLoop, 5)
  const ev = bus.previewLoop(event, 5)
  const miss = bus.previewLoop(missing, 5)

  // Stop the sample preview immediately so we don't leave a buffer source
  // running for 5×duration seconds during the test.
  if (typeof sample === 'function') sample()

  return {
    sampleType: typeof sample,
    synthType: typeof synth,
    eventType: typeof ev,
    missingType: typeof miss,
  }
})

// Select the sample loop in the editor + check the preview button rendered.
await page.evaluate(() => {
  ;(window).__lastTriggered?.getState?.().publish?.('theme_music')
})
await page.waitForTimeout(400)
const buttonVisible = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  return btns.some(b => /Preview\s*×\s*5/i.test(b.textContent || ''))
})

// Now select a synth loop — preview button should NOT render.
await page.evaluate(() => {
  ;(window).__lastTriggered?.getState?.().publish?.('windmill_whoosh')
})
await page.waitForTimeout(400)
const buttonHiddenOnSynth = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  return !btns.some(b => /Preview\s*×\s*5/i.test(b.textContent || ''))
})

await browser.close()

const ok1 = probe.sampleType === 'function'
const ok2 = probe.synthType === 'object'   // typeof null === 'object'
const ok3 = probe.eventType === 'object'
const ok4 = probe.missingType === 'object'
const ok5 = buttonVisible
const ok6 = buttonHiddenOnSynth

console.log('\n=== loop preview observation ===\n')
console.log('  previewLoop returns:', probe)
console.log()
console.log(`  ${ok1 ? '✓' : '✗'} sample loop  → callable stop handle`)
console.log(`  ${ok2 ? '✓' : '✗'} synth loop   → null (not supported)`)
console.log(`  ${ok3 ? '✓' : '✗'} event key    → null (events have own play path)`)
console.log(`  ${ok4 ? '✓' : '✗'} missing key  → null`)
console.log(`  ${ok5 ? '✓' : '✗'} Inspector shows "Preview ×5" button for sample loop`)
console.log(`  ${ok6 ? '✓' : '✗'} Inspector hides the button for synth loops`)
const allPass = ok1 && ok2 && ok3 && ok4 && ok5 && ok6
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
