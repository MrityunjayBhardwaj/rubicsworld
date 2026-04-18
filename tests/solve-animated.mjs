import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('pageerror', err => console.log(`[pageerror] ${err.message}`))
page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text()) })

await page.goto(URL)
await page.waitForTimeout(1500)

// Scramble then read state
await page.evaluate(() => window.__planet.getState().scrambleInstant(10))
await page.waitForTimeout(200)
const afterScramble = await page.evaluate(() => {
  const s = window.__planet.getState()
  return { solved: s.solved, historyLen: s.history.length }
})
console.log('after scramble:', JSON.stringify(afterScramble))

// Solve animated — await completion
await page.screenshot({ path: '/tmp/rubics-test/day7-solve-anim-00.png' })
const t0 = Date.now()
await page.evaluate(async () => {
  await window.__planet.getState().solveAnimated()
})
const elapsed = Date.now() - t0
console.log('solveAnimated took (ms):', elapsed)

// State after
const afterSolve = await page.evaluate(() => {
  const s = window.__planet.getState()
  return { solved: s.solved, historyLen: s.history.length, anim: s.anim, drag: s.drag }
})
console.log('after solve:', JSON.stringify(afterSolve))

await page.waitForTimeout(1000)
await page.screenshot({ path: '/tmp/rubics-test/day7-solve-anim-01.png' })

console.log('done')
await browser.close()
