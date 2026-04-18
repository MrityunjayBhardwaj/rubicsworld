import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log('[pageerror]', err.message))

await page.goto(URL)
await page.waitForTimeout(2000) // HDR preset load takes time
await page.screenshot({ path: '/tmp/rubics-test/day7-hdri-sunset.png' })

// Find BG opacity slider and set to 1 via evaluate (direct store)
// We don't have a direct accessor, so crank it via input range near "BG opacity"
const result = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input[type="range"]'))
  const labels = Array.from(document.querySelectorAll('div')).filter(d => d.textContent === 'BG opacity')
  return { inputCount: inputs.length, labelCount: labels.length }
})
console.log('panel probe:', JSON.stringify(result))

// Set last slider (BG opacity is the last one in HDRI panel)
await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('.\\:last-child input[type="range"]'))
  // Fallback: just find all range inputs in the HDRI panel area
})

// Simpler: directly set scene props via three, by finding an exposed hook
// We'll drive via HDRIPanel UI — click on range sliders relative position
const slider = await page.locator('input[type="range"]').nth(3) // BG opacity is 4th slider
await slider.fill('1')
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/rubics-test/day7-hdri-bg-on.png' })

// Switch to a different preset to check
const select = page.locator('select').first()
await select.selectOption('forest')
await page.waitForTimeout(2500)
await page.screenshot({ path: '/tmp/rubics-test/day7-hdri-forest.png' })

console.log('done')
await browser.close()
