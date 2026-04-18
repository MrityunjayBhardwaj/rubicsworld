import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

await page.goto(URL)
await page.waitForTimeout(1000)
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(500)

const dump = await page.evaluate(() => {
  const s = window.__planet.getState()
  return s.tiles.map(t => ({
    id: t.id,
    face: t.face,
    u: t.u,
    v: t.v,
    homeFace: t.homeFace,
    homeU: t.homeU,
    homeV: t.homeV,
  }))
})

for (const t of dump) {
  const canonical = t.face === t.homeFace && t.u === t.homeU && t.v === t.homeV
  console.log(`id=${t.id} face=${t.face}(home=${t.homeFace}) u=${t.u}(${t.homeU}) v=${t.v}(${t.homeV}) ${canonical ? 'OK' : '***DRIFT***'}`)
}
await browser.close()
