import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1000)

// Expose camera via R3F's internal state. React-three-fiber exposes the default
// store on the canvas element as part of fiber — need to find a canonical way.
// Workaround: we attached __planet to window; add a __r3f hook in main.tsx
// would require code change. For now, read from a known source:
const cam = await page.evaluate(() => {
  // Check if a known hook exists
  return { hasR3fGlobal: 'r3fGlobal' in window, hasPlanet: !!window.__planet }
})
console.log('window probes:', cam)

// Without a hook we can't easily read camera. Let me just look at the effect:
// expose label positions via DOM attribute hack
await page.evaluate(() => window.__planet.getState().setShowLabels(true))
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/rubics-test/day7-lab-final.png' })

await browser.close()
