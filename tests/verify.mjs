import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const NAME = process.env.NAME || 'day6-verify'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const logs = []
page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(2000)
await page.screenshot({ path: `/tmp/rubics-test/${NAME}.png` })

console.log('--- console ---')
for (const l of logs) console.log(l)
console.log('--- done ---')

await browser.close()
