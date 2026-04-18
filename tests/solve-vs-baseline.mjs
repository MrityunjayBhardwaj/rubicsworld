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

// Canonical solved state
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(500)

// Solved sphere, default angle
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-solved-default.png' })

// Flat grid view for reference (shows the designed 4x6 diorama)
await page.getByRole('button', { name: /Diorama \(grid\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-grid.png' })

// Cube view — shows how the 24 cells fold onto cube faces
await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-cube.png' })

// Split view — shows the clip-box split layout
await page.getByRole('button', { name: /Diorama \(split\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-split.png' })

// Back to sphere — confirm same "solved" look
await page.getByRole('button', { name: /Diorama \(split\)/ }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-solved-after-toggle.png' })

console.log('--- done ---')
await browser.close()
