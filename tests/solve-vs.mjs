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

// Scramble the puzzle
await page.evaluate(() => window.__planet.getState().scrambleInstant(20))
await page.waitForTimeout(200)
const scrambledSolved = await page.evaluate(() => window.__planet.getState().solved)
console.log('scrambled_solved:', scrambledSolved, '(expected false)')
await page.screenshot({ path: '/tmp/rubics-test/day7-01-scrambled.png' })

// Invoke solve()
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(200)
const afterSolve = await page.evaluate(() => {
  const s = window.__planet.getState()
  return {
    solved: s.solved,
    allAtHome: s.tiles.every(t => t.face === t.homeFace && t.u === t.homeU && t.v === t.homeV),
    anim: s.anim,
    drag: s.drag,
  }
})
console.log('after_solve:', JSON.stringify(afterSolve))
await page.waitForTimeout(2200) // wait for warmth ramp
await page.screenshot({ path: '/tmp/rubics-test/day7-02-after-solve-warm.png' })

// Now test VS: from canonical solved, rotate BOTH slices of y-axis by +90°.
// This produces a globally-rotated-but-assembled state. VS should say solved.
await page.evaluate(async () => {
  const s = window.__planet.getState()
  s.rotateInstant({ axis: 'y', slice: 0, dir: 1 })
  s.rotateInstant({ axis: 'y', slice: 1, dir: 1 })
})
await page.waitForTimeout(200)
const globalRot = await page.evaluate(() => {
  const s = window.__planet.getState()
  return {
    solved: s.solved,
    someAtHome: s.tiles.some(t => t.face === t.homeFace && t.u === t.homeU && t.v === t.homeV),
    allAtHome: s.tiles.every(t => t.face === t.homeFace && t.u === t.homeU && t.v === t.homeV),
  }
})
console.log('global_rot_Y:', JSON.stringify(globalRot))
await page.screenshot({ path: '/tmp/rubics-test/day7-03-globally-rotated.png' })

// Control: rotate only ONE slice — should NOT be solved (local rotation, breaks assembly)
await page.evaluate(() => window.__planet.getState().reset())
await page.waitForTimeout(150)
await page.evaluate(() => {
  window.__planet.getState().rotateInstant({ axis: 'y', slice: 0, dir: 1 })
})
await page.waitForTimeout(100)
const oneSlice = await page.evaluate(() => window.__planet.getState().solved)
console.log('single_slice_rotated_solved:', oneSlice, '(expected false)')
await page.screenshot({ path: '/tmp/rubics-test/day7-04-single-slice.png' })

console.log('--- console ---')
for (const l of logs) console.log(l)
console.log('--- done ---')
await browser.close()
