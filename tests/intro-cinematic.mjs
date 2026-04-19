import { chromium } from 'playwright'
const URL = process.env.URL || 'http://localhost:5176/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[PAGEERROR]', e.message))
await page.goto(URL)
await page.waitForTimeout(300)

const snap = () => page.evaluate(() => ({
  phase: window.__planet.getState().introPhase,
  solved: window.__planet.getState().solved,
  nMoves: window.__planet.getState().history.length,
  autoRotating: !!window.__scene,
}))

console.log('T=0.3s  :', JSON.stringify(await snap()))
await page.screenshot({ path: '/tmp/rubics-test/intro-0-load.png' })

await page.waitForTimeout(1500)
console.log('T=1.8s  :', JSON.stringify(await snap()))
await page.screenshot({ path: '/tmp/rubics-test/intro-1-hold.png' })

await page.waitForTimeout(1500)
console.log('T=3.3s  :', JSON.stringify(await snap()))
await page.screenshot({ path: '/tmp/rubics-test/intro-2-scrambling.png' })

await page.waitForTimeout(4000)
console.log('T=7.3s  :', JSON.stringify(await snap()))
await page.screenshot({ path: '/tmp/rubics-test/intro-3-scrambled.png' })

await page.waitForTimeout(4000)
console.log('T=11.3s :', JSON.stringify(await snap()))
await page.screenshot({ path: '/tmp/rubics-test/intro-4-orbiting.png' })

// Now hover planet → should end
const r3f = await page.evaluate(() => {
  const cs = Array.from(document.querySelectorAll('canvas'))
  let best = cs[0], bestArea = 0
  for (const c of cs) {
    const r = c.getBoundingClientRect()
    const a = r.width * r.height
    if (a > bestArea) { bestArea = a; best = c }
  }
  const r = best.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
await page.mouse.move(r3f.x + r3f.w / 2, r3f.y + r3f.h / 2)
await page.waitForTimeout(400)
console.log('T=after hover:', JSON.stringify(await snap()))
await page.screenshot({ path: '/tmp/rubics-test/intro-5-hovered.png' })

console.log('done')
await browser.close()
