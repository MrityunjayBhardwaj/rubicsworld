// Phase 3 probe — observe tutorial overlay + chrome render during 'tutorial' phase.
import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('[CONSOLEERR]', m.text()) })

await page.goto(URL)
await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })
await page.evaluate(() => localStorage.removeItem('rubicsworld:tutorialSeen'))
await page.reload()
await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })

const waitForPhase = async target => {
  await page.waitForFunction(
    t => window.__planet?.getState().introPhase === t,
    target,
    { timeout: 20000, polling: 150 },
  )
}

await waitForPhase('tutorial')
await page.waitForTimeout(600) // let Lottie mount + useFrame settle

const snap = await page.evaluate(() => {
  const skipBtn = Array.from(document.querySelectorAll('button'))
    .find(b => /skip tutorial/i.test(b.innerText))
  const chromeText = document.body.innerText.match(/Swipe.+\d+ of \d+/)?.[0] ?? null
  // Drei Html renders into a portal sibling of the canvas — Lottie's rendered
  // SVG lives there. Look for .drei-html descendants.
  const htmlRoots = document.querySelectorAll('[id^="tunnel"], [class*="drei"]')
  const allSvgs = document.querySelectorAll('svg')
  return {
    phase: window.__planet.getState().introPhase,
    step: window.__planet.getState().tutorialStep,
    queueLen: window.__planet.getState().tutorialQueue.length,
    skipButtonText: skipBtn?.innerText ?? null,
    chromeText,
    totalSvgs: allSvgs.length,
    htmlRootsCount: htmlRoots.length,
  }
})
console.log('tutorial snap:', JSON.stringify(snap, null, 2))

await page.screenshot({ path: '/tmp/rubics-test/tut-phase3-overlay.png' })
console.log('screenshot → /tmp/rubics-test/tut-phase3-overlay.png')

await browser.close()

const ok =
  snap.phase === 'tutorial' &&
  snap.queueLen === 3 &&
  snap.step === 0 &&
  snap.skipButtonText?.toLowerCase().includes('skip') &&
  snap.chromeText &&
  snap.totalSvgs > 0

console.log('verdict:', ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
