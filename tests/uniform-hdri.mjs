import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(URL)
await page.waitForTimeout(1500)

// Select "uniform" via the select element inside the HDRI panel
const hdri = page.locator('div').filter({ hasText: /^HDRI/ }).first()
// Preset select
await page.selectOption('select', 'uniform')
await page.waitForTimeout(400)
// Set color to red via the color input
const colorInput = page.locator('input[type="color"]')
await colorInput.first().fill('#ff2020')
await page.waitForTimeout(400)

// Read scene state from the R3F canvas context via three's scene traversal isn't exposed.
// Instead, read DOM state: swatch bg color and select value.
const debug = await page.evaluate(() => {
  const sel = document.querySelector('select')
  const color = document.querySelector('input[type="color"]')
  return { preset: sel?.value, color: color?.value }
})
console.log('DOM state:', debug)

await page.screenshot({ path: '/tmp/rubics-test/uniform-red.png' })

// Toggle physical lights OFF to see IBL-only orange tint
const cb = page.locator('input[type="checkbox"]')
await cb.first().uncheck()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/uniform-red-ibl.png' })

// Crank BG opacity to max via slider (find the one labeled BG opacity)
const slid = page.locator('input[type="range"]').last()
await slid.fill('1')
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/rubics-test/uniform-red-bg.png' })

console.log('done')
await browser.close()
