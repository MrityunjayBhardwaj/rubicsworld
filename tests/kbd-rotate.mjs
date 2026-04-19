import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text()) })
await page.goto(URL)
await page.waitForTimeout(3000)

// Target the R3F canvas (largest canvas on page).
const r3fBox = await page.evaluate(() => {
  const canvases = Array.from(document.querySelectorAll('canvas'))
  let best = canvases[0], bestArea = 0
  for (const c of canvases) {
    const r = c.getBoundingClientRect()
    const area = r.width * r.height
    if (area > bestArea) { bestArea = area; best = c }
  }
  const r = best.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
const cx = r3fBox.x + r3fBox.width / 2
const cy = r3fBox.y + r3fBox.height / 2
console.log('r3f canvas:', r3fBox, 'target:', cx, cy)

const readTiles = () => page.evaluate(() =>
  window.__planet.getState().tiles.map(t => ({ h: t.homeFace, f: t.face, u: t.u, v: t.v })))

await page.mouse.move(cx, cy)
await page.waitForTimeout(300)

const hovered = await page.evaluate(() => window.__planet.getState().hoveredTile)
console.log('hovered:', hovered)

const before = await readTiles()

// Q
await page.keyboard.press('q')
await page.waitForTimeout(500)
const afterQ = await readTiles()
console.log('Q changed:', JSON.stringify(before) !== JSON.stringify(afterQ))

// E (undo Q)
await page.keyboard.press('e')
await page.waitForTimeout(500)
const afterE = await readTiles()
console.log('E restored:', JSON.stringify(before) === JSON.stringify(afterE))

// W, S
await page.mouse.move(cx, cy)
await page.waitForTimeout(100)
await page.keyboard.press('w')
await page.waitForTimeout(500)
await page.keyboard.press('s')
await page.waitForTimeout(500)
const afterWS = await readTiles()
console.log('W then S restored:', JSON.stringify(before) === JSON.stringify(afterWS))

// A, D
await page.mouse.move(cx, cy)
await page.waitForTimeout(100)
await page.keyboard.press('a')
await page.waitForTimeout(500)
await page.keyboard.press('d')
await page.waitForTimeout(500)
const afterAD = await readTiles()
console.log('A then D restored:', JSON.stringify(before) === JSON.stringify(afterAD))

await page.screenshot({ path: '/tmp/rubics-test/kbd-rotate.png' })

console.log('done')
await browser.close()
