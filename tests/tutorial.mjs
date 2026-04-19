// End-to-end tutorial verification.
//
// Covers four scenarios:
//   1. Fresh visit → 3-move scramble → guided solve → 'done' + flag
//   2. Fresh visit → wrong move → BFS rebuilds queue → solve → 'done' + flag
//   3. Repeat visit (flag set) → 18-move attract intro, no overlay
//   4. Skip button → 'done' + flag, no further moves required
//
// Drives the planet via window.__planet so the test doesn't depend on screen
// coordinates. Each scenario asserts on the final store state + localStorage.
import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const FLAG = 'rubicsworld:tutorialSeen'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))

const freshLoad = async () => {
  await page.goto(URL)
  await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })
  await page.evaluate(flag => localStorage.removeItem(flag), FLAG)
  await page.reload()
  await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })
}

const seededLoad = async () => {
  await page.goto(URL)
  await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })
  await page.evaluate(flag => localStorage.setItem(flag, '1'), FLAG)
  await page.reload()
  await page.waitForFunction(() => !!window.__planet, null, { timeout: 10000 })
}

const waitForPhase = async (target, timeout = 20000) =>
  page.waitForFunction(
    t => window.__planet?.getState().introPhase === t,
    target,
    { timeout, polling: 150 },
  )

const snap = () => page.evaluate(flag => {
  const s = window.__planet.getState()
  return {
    phase: s.introPhase,
    step: s.tutorialStep,
    queueLen: s.tutorialQueue.length,
    solved: s.solved,
    nMoves: s.history.length,
    flag: localStorage.getItem(flag),
  }
}, FLAG)

const driveQueue = async (maxIter = 10) => {
  for (let i = 0; i < maxIter; i++) {
    const s = await snap()
    if (s.phase !== 'tutorial') return
    const applied = await page.evaluate(async () => {
      const st = window.__planet.getState()
      const m = st.tutorialQueue[st.tutorialStep]
      if (!m) return null
      await st.rotateAnimated(m)
      return m
    })
    if (!applied) return
    await page.waitForTimeout(60)
  }
}

const results = []

// ── Scenario 1: happy path ──────────────────────────────────────────────
{
  await freshLoad()
  await waitForPhase('tutorial')
  const t0 = await snap()
  await driveQueue()
  const t1 = await snap()
  const ok =
    t0.phase === 'tutorial' && t0.queueLen === 3 && t0.step === 0 &&
    t1.phase === 'done' && t1.solved === true && t1.flag === '1' &&
    t1.nMoves === 6
  results.push(['happy-path', ok, { t0, t1 }])
  await page.screenshot({ path: '/tmp/rubics-test/tutorial-s1-happy.png' })
}

// ── Scenario 2: wrong move → BFS re-solve ───────────────────────────────
{
  await freshLoad()
  await waitForPhase('tutorial')
  const t0 = await snap()
  await page.evaluate(async () => {
    const s = window.__planet.getState()
    const exp = s.tutorialQueue[0]
    for (const a of ['x', 'y', 'z']) for (const sl of [0, 1]) for (const d of [1, -1]) {
      if (a === exp.axis && sl === exp.slice && d === exp.dir) continue
      await s.rotateAnimated({ axis: a, slice: sl, dir: d })
      return
    }
  })
  await page.waitForTimeout(120)
  const t1 = await snap() // post-wrong, post-BFS
  await driveQueue()
  const t2 = await snap()
  const ok =
    t0.phase === 'tutorial' &&
    t1.phase === 'tutorial' && t1.step === 0 && t1.queueLen >= 1 && t1.queueLen <= 5 &&
    t2.phase === 'done' && t2.solved === true && t2.flag === '1'
  results.push(['bfs-resolve', ok, { t0, t1, t2 }])
  await page.screenshot({ path: '/tmp/rubics-test/tutorial-s2-bfs.png' })
}

// ── Scenario 3: repeat visit (attract only) ─────────────────────────────
{
  await seededLoad()
  await waitForPhase('orbit-scrambled')
  const t = await snap()
  const overlayCount = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).filter(b => /skip tutorial/i.test(b.innerText)).length,
  )
  const ok =
    t.phase === 'orbit-scrambled' &&
    t.nMoves === 18 &&
    t.queueLen === 0 && // tutorial queue never populated
    overlayCount === 0 // no skip button
  results.push(['repeat-visit', ok, { t, overlayCount }])
  await page.screenshot({ path: '/tmp/rubics-test/tutorial-s3-repeat.png' })
}

// ── Scenario 4: skip button ─────────────────────────────────────────────
{
  await freshLoad()
  await waitForPhase('tutorial')
  const t0 = await snap()
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .find(b => /skip tutorial/i.test(b.innerText))
      ?.click(),
  )
  await page.waitForTimeout(120)
  const t1 = await snap()
  const ok = t0.phase === 'tutorial' && t1.phase === 'done' && t1.flag === '1'
  results.push(['skip-button', ok, { t0, t1 }])
  await page.screenshot({ path: '/tmp/rubics-test/tutorial-s4-skip.png' })
}

await browser.close()

let allPass = true
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`)
  if (!ok) allPass = false
}
console.log('\nOVERALL:', allPass ? 'PASS' : 'FAIL')
process.exit(allPass ? 0 : 1)
