import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
await page.goto(URL)
await page.waitForTimeout(3000)

const r3fBox = await page.evaluate(() => {
  const cs = Array.from(document.querySelectorAll('canvas'))
  let best = cs[0], bestArea = 0
  for (const c of cs) {
    const r = c.getBoundingClientRect()
    const a = r.width * r.height
    if (a > bestArea) { bestArea = a; best = c }
  }
  const r = best.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
const cx = r3fBox.x + r3fBox.width / 2
const cy = r3fBox.y + r3fBox.height / 2

// Attract mode (fresh load)
await page.screenshot({ path: '/tmp/rubics-test/hud-lines-attract.png' })

// Solve + zoom
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(500)

for (let i = 0; i < 25; i++) {
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(20)
}
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/hud-lines-solved-attract.png' })

// Easy mode on
await page.evaluate(() => window.__planet.getState().setEasyMode(true))
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/rubics-test/hud-lines-solved-easy.png' })

// One move to scramble partially
await page.keyboard.press('q')
await page.waitForTimeout(700)
await page.screenshot({ path: '/tmp/rubics-test/hud-lines-onemove-easy.png' })

// Turn easy off — should fade back to pure yellow lines
await page.evaluate(() => window.__planet.getState().setEasyMode(false))
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/rubics-test/hud-lines-onemove-yellow.png' })

console.log('done')
await browser.close()
