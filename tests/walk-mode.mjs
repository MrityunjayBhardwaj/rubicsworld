import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text()) })
await page.goto(URL)
await page.waitForTimeout(3000)

// Click the Leva "Walk on planet" button (real user gesture → pointer-lock eligible)
const btn = page.locator('text=Walk on planet').first()
const exists = await btn.count()
console.log('button exists:', exists)
if (exists > 0) {
  await btn.click()
  await page.waitForTimeout(600)
}

let state = await page.evaluate(() => window.__planet.getState().cameraMode)
console.log('cameraMode after button click:', state)

await page.screenshot({ path: '/tmp/rubics-test/walk-after-click.png' })

// Simulate walking with WASD
await page.keyboard.down('w')
await page.waitForTimeout(1000)
await page.keyboard.up('w')
await page.waitForTimeout(200)
await page.screenshot({ path: '/tmp/rubics-test/walk-after-w.png' })

// Exit via Tab
await page.keyboard.press('Tab')
await page.waitForTimeout(400)
state = await page.evaluate(() => window.__planet.getState().cameraMode)
console.log('cameraMode after Tab:', state)
await page.screenshot({ path: '/tmp/rubics-test/walk-after-tab.png' })

console.log('done')
await browser.close()
