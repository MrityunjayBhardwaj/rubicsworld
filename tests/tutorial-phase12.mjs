// Phase 1+2 probe — verify tutorial branch fires on fresh visit, attract
// branch fires on repeat visit. Polls for phase transitions.
import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))

const snap = () => page.evaluate(() => {
  const s = window.__planet.getState()
  return {
    phase: s.introPhase,
    solved: s.solved,
    nMoves: s.history.length,
    queueLen: s.tutorialQueue?.length ?? -1,
    step: s.tutorialStep ?? -1,
  }
})

const waitForPhase = async (target, timeoutMs = 20000) => {
  await page.waitForFunction(
    t => window.__planet?.getState().introPhase === t,
    target,
    { timeout: timeoutMs, polling: 200 },
  )
}

// ───── FRESH VISIT (tutorial branch) ─────
await page.goto(URL)
await page.evaluate(() => localStorage.removeItem('rubicsworld:tutorialSeen'))
await page.reload()
await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })

console.log('fresh start:', JSON.stringify(await snap()))
await waitForPhase('tutorial', 15000).catch(() => {})
const fresh = await snap()
console.log('fresh @ tutorial:', JSON.stringify(fresh))
await page.screenshot({ path: '/tmp/rubics-test/tut-phase12-fresh.png' })

const okFresh =
  fresh.phase === 'tutorial' &&
  fresh.nMoves === 3 &&
  fresh.queueLen === 3 &&
  fresh.step === 0 &&
  fresh.solved === false
console.log('fresh verdict:', okFresh ? 'PASS' : 'FAIL')

// ───── REPEAT VISIT (attract branch) ─────
await page.evaluate(() => localStorage.setItem('rubicsworld:tutorialSeen', '1'))
await page.reload()
await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })

console.log('repeat start:', JSON.stringify(await snap()))
await waitForPhase('orbit-scrambled', 20000).catch(() => {})
const repeat = await snap()
console.log('repeat @ orbit-scrambled:', JSON.stringify(repeat))
await page.screenshot({ path: '/tmp/rubics-test/tut-phase12-repeat.png' })

const okRepeat =
  repeat.phase === 'orbit-scrambled' &&
  repeat.nMoves === 18 &&
  repeat.solved === false
console.log('repeat verdict:', okRepeat ? 'PASS' : 'FAIL')

console.log('\nOVERALL:', okFresh && okRepeat ? 'PASS' : 'FAIL')
await browser.close()
process.exit(okFresh && okRepeat ? 0 : 1)
