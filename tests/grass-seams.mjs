import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1500)

await page.evaluate(() => {
  const s = window.__planet.getState()
  s.setShowLabels(false)
  s.solve()
})
await page.waitForTimeout(1500)

// Sphere default
await page.screenshot({ path: '/tmp/rubics-test/day7-grass-sphere.png' })

// Cube view for seam check
await page.getByRole('button', { name: /View: Cube$/i }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-grass-cube.png' })

// Cube net for flat check
await page.getByRole('button', { name: /View: Cube$/i }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /View: Cube net/i }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-grass-net.png' })

console.log('done')
await browser.close()
