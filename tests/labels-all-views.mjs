import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const logs = []
page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1200)

// Start with a canonical solved state so numbers at home match cell indices
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(300)

// Toggle "Tile numbers" on (via the store — Leva's DOM is easier to bypass)
await page.evaluate(() => window.__planet.getState().setShowLabels(true))
await page.waitForTimeout(300)

// Sphere mode (default)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-01-sphere.png' })

// Grid
await page.getByRole('button', { name: /Diorama \(grid\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-02-grid.png' })

// Split
await page.getByRole('button', { name: /Diorama \(split\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-03-split.png' })

// Cube
await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-04-cube.png' })

// Back to sphere
await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(400)

// Scramble and see labels follow tiles
await page.evaluate(() => window.__planet.getState().scrambleInstant(12))
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-05-sphere-scrambled.png' })

// Drag mid to see labels follow drag
const cx = 640, cy = 400
await page.mouse.move(cx, cy)
await page.mouse.down()
await page.mouse.move(cx - 80, cy, { steps: 10 })
await page.waitForTimeout(100)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-06-mid-drag.png' })
await page.mouse.up()
await page.waitForTimeout(500)

for (const l of logs) console.log(l)
console.log('done')
await browser.close()
