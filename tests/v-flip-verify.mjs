import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1500)

await page.evaluate(() => {
  const s = window.__planet.getState()
  s.setShowLabels(true)
  s.solve()
})
await page.waitForTimeout(1500)

// Sphere solved
await page.screenshot({ path: '/tmp/rubics-test/day7-vflip-sphere.png' })

// Dump tile state: every tile at home?
const dump = await page.evaluate(() => {
  const s = window.__planet.getState()
  return s.tiles.every(t => t.face === t.homeFace && t.u === t.homeU && t.v === t.homeV)
})
console.log('all_at_home:', dump)

// Grid
await page.getByRole('button', { name: /View: Cube net/i }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: '/tmp/rubics-test/day7-vflip-grid.png' })

// Cube
await page.getByRole('button', { name: /View: Sphere/i }).click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: /View: Cube$/i }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: '/tmp/rubics-test/day7-vflip-cube.png' })

console.log('done')
await browser.close()
