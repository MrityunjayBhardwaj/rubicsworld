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
await page.evaluate(() => window.__planet.getState().setShowLabels(true))
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(1800)

// Sphere, solved
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-sphere-solved.png' })

// Sphere, scrambled
await page.evaluate(() => window.__planet.getState().scrambleInstant(10))
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-sphere-scrambled.png' })

// Grid
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(200)
await page.getByRole('button', { name: /Diorama \(grid\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-grid.png' })

// Cube (via clicking Grid off, then Cube)
await page.getByRole('button', { name: /Diorama \(grid\)/ }).click()  // grid off → sphere
await page.waitForTimeout(300)
await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-cube.png' })

// Split
await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /Diorama \(split\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-split.png' })

console.log('--- done ---')
for (const l of logs) console.log(l)
await browser.close()
