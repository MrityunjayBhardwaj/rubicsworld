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

// Click "Diorama (split)" in leva panel
await page.getByRole('button', { name: /Diorama \(split\)/ }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day6-pv-split.png' })

await page.getByRole('button', { name: /Diorama \(cube\)/ }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day6-pv-cube.png' })

await page.getByRole('button', { name: /Diorama \(grid\)/ }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day6-pv-grid.png' })

console.log('--- console ---')
for (const l of logs) console.log(l)
console.log('--- done ---')
await browser.close()
