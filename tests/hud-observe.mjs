import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text()) })
await page.goto(URL)
await page.waitForTimeout(3000)

// Fresh load — HUD should cover the whole planet.
await page.screenshot({ path: '/tmp/rubics-test/hud-attract.png' })

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

await page.mouse.move(cx, cy)
await page.waitForTimeout(200)
await page.screenshot({ path: '/tmp/rubics-test/hud-hover.png' })

// Press Q to trigger first commit → attract fades
await page.keyboard.press('q')
await page.waitForTimeout(1500) // wait for anim + HUD fade
await page.screenshot({ path: '/tmp/rubics-test/hud-postcommit.png' })

// Move cursor off-planet then back
await page.mouse.move(100, 100)
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/hud-cursor-off.png' })

await page.mouse.move(cx, cy)
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/rubics-test/hud-cursor-on.png' })

console.log('done')
await browser.close()
