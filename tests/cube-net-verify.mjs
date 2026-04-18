import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1500)
await page.evaluate(() => window.__planet.getState().setShowLabels(true))
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(1500)

// Sphere solved
await page.screenshot({ path: '/tmp/rubics-test/day7-net-sphere-solved.png' })

// Go to grid directly
await page.getByRole('button', { name: /Diorama \(grid\)/ }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-net-grid.png' })

// Back to sphere
await page.getByRole('button', { name: /Diorama \(grid\)/ }).click()
await page.waitForTimeout(400)

// Cube
await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-net-cube.png' })

// Back to sphere
await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(400)

// Split
await page.getByRole('button', { name: /Diorama \(split\)/ }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-net-split.png' })

console.log('done')
await browser.close()
