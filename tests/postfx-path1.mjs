// Path 1 visual probe — inject state directly to skip the animated
// scramble (headless Chromium is slow; real browsers tested manually).
import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))

await page.goto(URL)
await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })
await page.evaluate(() => localStorage.setItem('rubicsworld:tutorialSeen', '1'))
await page.reload()
await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })

// Skip the intro entirely and scramble directly
await page.evaluate(() => {
  const s = window.__planet.getState()
  s.setIntroPhase('done')
  s.scrambleInstant(18)
})
await page.waitForTimeout(1500) // let effect chain stabilise

await page.screenshot({ path: '/tmp/rubics-test/postfx1-default.png' })

// Side angle
await page.mouse.move(700, 450)
await page.mouse.down()
await page.mouse.move(950, 450, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/postfx1-side.png' })

// Close zoom
await page.mouse.wheel(0, -800)
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/postfx1-close.png' })

// Walk mode
await page.evaluate(() => window.__planet.getState().setCameraMode('walk'))
await page.waitForTimeout(600)
await page.screenshot({ path: '/tmp/rubics-test/postfx1-walk.png' })

console.log('Screenshots: /tmp/rubics-test/postfx1-*.png')
await browser.close()
