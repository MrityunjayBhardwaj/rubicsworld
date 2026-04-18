import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const logs = []
page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(2000)

// Helper to read tile state from window.__planet
const getTiles = () => page.evaluate(() => {
  const s = window.__planet.getState()
  return s.tiles.map(t => ({ id: t.id, face: t.face, u: t.u, v: t.v }))
})

const tilesBefore = await getTiles()
console.log('tiles before drag[0..3]:', JSON.stringify(tilesBefore.slice(0, 4)))

await page.screenshot({ path: '/tmp/rubics-test/day6-drag-00-initial.png' })

// Drag mid-screen: middle of sphere → left drag ~120px
const cx = 640, cy = 400
await page.mouse.move(cx, cy)
await page.waitForTimeout(200)
await page.mouse.down()
await page.mouse.move(cx - 30, cy, { steps: 8 })
await page.waitForTimeout(80)
await page.screenshot({ path: '/tmp/rubics-test/day6-drag-01-mid.png' })
await page.mouse.move(cx - 120, cy, { steps: 12 })
await page.waitForTimeout(80)
await page.screenshot({ path: '/tmp/rubics-test/day6-drag-02-past-threshold.png' })

// Verify drag state mid-drag
const mid = await page.evaluate(() => {
  const s = window.__planet.getState()
  return { drag: s.drag, anim: s.anim }
})
console.log('mid-drag state:', JSON.stringify(mid))

await page.mouse.up()
await page.waitForTimeout(500) // wait for settle animation
await page.screenshot({ path: '/tmp/rubics-test/day6-drag-03-after-release.png' })

const after = await page.evaluate(() => {
  const s = window.__planet.getState()
  return { drag: s.drag, anim: s.anim }
})
console.log('after-release state:', JSON.stringify(after))

const tilesAfter = await getTiles()
console.log('tiles after drag[0..3]:', JSON.stringify(tilesAfter.slice(0, 4)))

const changed = tilesBefore.some((t, i) =>
  t.face !== tilesAfter[i].face || t.u !== tilesAfter[i].u || t.v !== tilesAfter[i].v
)
console.log('tiles_changed:', changed)

console.log('--- console ---')
for (const l of logs) console.log(l)
console.log('--- done ---')

await browser.close()
