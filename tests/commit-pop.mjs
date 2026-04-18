import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const logs = []
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`))

await page.goto(URL)
// Force a solved planet so we start from a predictable state
await page.waitForTimeout(1000)
await page.evaluate(() => window.__planet.getState().reset())
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day6-pop-00-solved.png' })

// Drag past threshold on axis-Y slice-1
const cx = 640, cy = 400
await page.mouse.move(cx, cy)
await page.mouse.down()
await page.mouse.move(cx - 120, cy, { steps: 14 })
await page.waitForTimeout(80)

// Frame right BEFORE release — peak animation
await page.screenshot({ path: '/tmp/rubics-test/day6-pop-01-peak-drag.png' })

await page.mouse.up()
// After release, the 380ms eased anim runs. Capture every ~80ms.
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(80)
  await page.screenshot({ path: `/tmp/rubics-test/day6-pop-02-settle-${i}.png` })
}

// 500ms after commit — fully settled
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day6-pop-03-final.png' })

// Inverse drag: rotate back
await page.mouse.move(cx, cy)
await page.mouse.down()
await page.mouse.move(cx + 120, cy, { steps: 14 })
await page.waitForTimeout(80)
await page.mouse.up()
await page.waitForTimeout(600)
await page.screenshot({ path: '/tmp/rubics-test/day6-pop-04-back-to-start.png' })

for (const l of logs) console.log(l)
console.log('done')
await browser.close()
