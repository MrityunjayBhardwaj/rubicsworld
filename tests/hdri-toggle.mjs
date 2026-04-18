import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log('[pageerror]', err.message))

await page.goto(URL)
await page.waitForTimeout(2500)

// Physical lights on (default)
await page.screenshot({ path: '/tmp/rubics-test/day7-lights-on.png' })

// Toggle off
await page.locator('input[type="checkbox"]').first().uncheck()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-lights-off.png' })

// Toggle back on
await page.locator('input[type="checkbox"]').first().check()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/rubics-test/day7-lights-on-again.png' })

console.log('done')
await browser.close()
