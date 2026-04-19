import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
page.on('console', m => { if (m.type() === 'log' && m.text().includes('HDRIEnv')) console.log('BROWSER:', m.text()) })
await page.goto(URL)
await page.waitForTimeout(3000)

const snap = () => page.evaluate(() => ({
  store: {
    intensity: window.__hdri.getState().intensity,
    blur: window.__hdri.getState().blur,
    rotation: window.__hdri.getState().rotation,
    bgOp: window.__hdri.getState().backgroundOpacity,
    preset: window.__hdri.getState().preset,
  },
  scene: window.__scene ? {
    envI: window.__scene.environmentIntensity,
    bgI: window.__scene.backgroundIntensity,
    blur: window.__scene.backgroundBlurriness,
    envRotY: window.__scene.environmentRotation?.y ?? null,
    bgRotY: window.__scene.backgroundRotation?.y ?? null,
    hasEnv: !!window.__scene.environment,
    hasBg: !!window.__scene.background,
  } : 'no scene',
  cameraMode: window.__planet.getState().cameraMode,
}))

console.log('FRESH    :', JSON.stringify(await snap()))

await page.evaluate(() => {
  window.__hdri.getState().setIntensity(3.0)
  window.__hdri.getState().setBlur(0.6)
  window.__hdri.getState().setRotation(1.5)
  window.__hdri.getState().setBackgroundOpacity(0.8)
})
await page.waitForTimeout(300)
console.log('AFTER SET:', JSON.stringify(await snap()))

// Drag bezier
const bez = await page.evaluate(() => {
  const cs = Array.from(document.querySelectorAll('canvas'))
  const small = cs.filter(c => c.width <= 400 && c.height <= 400)
  if (!small.length) return null
  const r = small[0].getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
if (bez) {
  await page.mouse.move(bez.x + 40, bez.y + 140)
  await page.mouse.down()
  await page.mouse.move(bez.x + 80, bez.y + 60, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  console.log('AFTER BEZ:', JSON.stringify(await snap()))
}

const btn = page.locator('text=Walk on planet').first()
await btn.click()
await page.waitForTimeout(500)
console.log('WALK     :', JSON.stringify(await snap()))

// Tweak intensity while walking
await page.evaluate(() => window.__hdri.getState().setIntensity(0.5))
await page.waitForTimeout(300)
console.log('WALK+SET :', JSON.stringify(await snap()))

await browser.close()
