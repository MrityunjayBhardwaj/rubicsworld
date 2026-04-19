import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
await page.goto(URL)
await page.waitForTimeout(3000)

const btn = page.locator('text=Walk on planet').first()
await btn.click()
await page.waitForTimeout(500)

let state = await page.evaluate(() => window.__planet.getState().cameraMode)
console.log('cameraMode after click:', state)

const canvas = await page.evaluate(() => {
  const cs = Array.from(document.querySelectorAll('canvas'))
  let best = cs[0], bestArea = 0
  for (const c of cs) {
    const r = c.getBoundingClientRect()
    const a = r.width * r.height
    if (a > bestArea) { bestArea = a; best = c }
  }
  const r = best.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const cx = canvas.x + canvas.w / 2
const cy = canvas.y + canvas.h / 2

// Snapshot before mouse-look
await page.screenshot({ path: '/tmp/rubics-test/walk-mlook-0.png' })

// Pan right via mouse-delta (playwright's mouse.move triggers mousemove with
// populated movementX regardless of pointer lock).
await page.mouse.move(cx, cy)
for (let i = 0; i < 10; i++) {
  await page.mouse.move(cx + 50 + i * 40, cy, { steps: 1 })
  await page.waitForTimeout(30)
}
await page.screenshot({ path: '/tmp/rubics-test/walk-mlook-right.png' })

// Pan up
await page.mouse.move(cx, cy)
for (let i = 0; i < 8; i++) {
  await page.mouse.move(cx, cy - 40 - i * 30, { steps: 1 })
  await page.waitForTimeout(30)
}
await page.screenshot({ path: '/tmp/rubics-test/walk-mlook-up.png' })

// Forward walk
await page.keyboard.down('w')
await page.waitForTimeout(1000)
await page.keyboard.up('w')
await page.screenshot({ path: '/tmp/rubics-test/walk-mlook-after-w.png' })

await page.keyboard.press('Tab')
await page.waitForTimeout(400)
console.log('done')
await browser.close()
