import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

await page.goto(URL)
await page.waitForTimeout(1500)
await page.evaluate(() => window.__planet.getState().setShowLabels(true))
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(500)

// Set grid view via direct React state isn't possible here; use the store-exposed
// hook to open grid mode by invoking the menu button.
await page.getByRole('button', { name: /View: Cube net/i }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-order-grid.png' })

console.log('done')
await browser.close()
