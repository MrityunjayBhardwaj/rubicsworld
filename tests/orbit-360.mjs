import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log('[pageerror]', err.message))

await page.goto(URL)
await page.waitForTimeout(2000)

await page.screenshot({ path: '/tmp/rubics-test/day7-orbit-00.png' })

// Simulate vertical drag from upper-outside-planet area to below bottom of planet —
// i.e., pass the camera over the top pole.
const cx = 640
// Start above the planet (y < ~200, planet is around center)
for (let i = 0; i < 4; i++) {
  const startY = 100
  const endY = 700
  await page.mouse.move(cx, startY)
  await page.mouse.down()
  await page.mouse.move(cx, endY, { steps: 20 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `/tmp/rubics-test/day7-orbit-${String(i + 1).padStart(2, '0')}.png` })
}

console.log('done')
await browser.close()
