import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const logs = []
page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1200)

// Hypothesis 1: VS is over-eager. Is the initial scrambled state incorrectly solved?
const initial = await page.evaluate(() => {
  const s = window.__planet.getState()
  return {
    solved: s.solved,
    tiles_sample: s.tiles.slice(0, 6).map(t => ({
      id: t.id,
      face: t.face, u: t.u, v: t.v,
      home: `${t.homeFace},${t.homeU},${t.homeV}`,
      q: [t.orientation.x.toFixed(3), t.orientation.y.toFixed(3), t.orientation.z.toFixed(3), t.orientation.w.toFixed(3)],
    })),
  }
})
console.log('initial:', JSON.stringify(initial, null, 2))

// Hypothesis 2: After solve(), verify tiles really are canonical.
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(300)
const solved = await page.evaluate(() => {
  const s = window.__planet.getState()
  const allHome = s.tiles.every(t => t.face === t.homeFace && t.u === t.homeU && t.v === t.homeV)
  const allIdent = s.tiles.every(t => {
    const q = t.orientation
    return Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) < 1e-4
  })
  return {
    solved: s.solved,
    allAtHome: allHome,
    allIdentOrientation: allIdent,
    tile_count: s.tiles.length,
  }
})
console.log('after_solve:', JSON.stringify(solved))

// Take a fresh screenshot AFTER warmth has ramped + orbit to top-down view to see +Y face.
await page.evaluate(() => {
  // Orbit camera to top-down by rotating via mouse would be complex.
  // Easier: dispatch a direct camera manipulation via exposed globals? No such hook.
})
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-01-solved-angle1.png' })

// Drag-orbit the camera so we see the +Y face directly.
// OrbitControls responds to RIGHT button in sphere mode per App.tsx.
const cx = 640, cy = 400
// Pull camera up by dragging right button downward
await page.mouse.move(cx, cy)
await page.mouse.down({ button: 'right' })
await page.mouse.move(cx, cy + 180, { steps: 8 })
await page.mouse.up({ button: 'right' })
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-02-solved-top.png' })

// Rotate more — side view
await page.mouse.move(cx, cy)
await page.mouse.down({ button: 'right' })
await page.mouse.move(cx + 220, cy, { steps: 10 })
await page.mouse.up({ button: 'right' })
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-03-solved-side.png' })

// Compare: scramble then Reset (not Solve) to see if that's different
await page.evaluate(() => {
  window.__planet.getState().scrambleInstant(20)
})
await page.waitForTimeout(200)
await page.evaluate(() => window.__planet.getState().reset())
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/rubics-test/day7-inv-04-after-reset.png' })

// Baseline: what does the puzzle look like with INITIAL (fresh-load) state but solved=true?
// Answer: just use reset().

console.log('--- done ---')
await browser.close()
