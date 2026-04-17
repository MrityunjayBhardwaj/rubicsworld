import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const logs = []
page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1500)

// Initial (unsolved, low bloom, some vignette)
await page.screenshot({ path: '/tmp/rubics-test/day6-pf-01-unsolved.png' })

// Mid drag — should still preview live
const cx = 640, cy = 400
await page.mouse.move(cx, cy)
await page.mouse.down()
await page.mouse.move(cx - 80, cy, { steps: 10 })
await page.waitForTimeout(80)
await page.screenshot({ path: '/tmp/rubics-test/day6-pf-02-mid-drag.png' })
await page.mouse.up()
await page.waitForTimeout(500)

// Force solved state — bloom should ramp up (warmth 0→1 over 2s)
await page.evaluate(() => {
  window.__planet.getState().reset()
})
await page.waitForTimeout(2300)
await page.screenshot({ path: '/tmp/rubics-test/day6-pf-03-solved-warm.png' })

// Then scramble back — bloom should damp
await page.evaluate(() => {
  window.__planet.getState().scrambleInstant(6)
})
await page.waitForTimeout(2300)
await page.screenshot({ path: '/tmp/rubics-test/day6-pf-04-scrambled-cool.png' })

console.log('--- console ---')
for (const l of logs) console.log(l)
console.log('--- done ---')
await browser.close()
