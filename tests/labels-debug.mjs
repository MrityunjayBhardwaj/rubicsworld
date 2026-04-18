import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

page.on('console', msg => console.log(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', err => console.log(`[pageerror] ${err.message}`))

await page.goto(URL)
await page.waitForTimeout(1000)
await page.evaluate(() => window.__planet.getState().setShowLabels(true))
await page.evaluate(() => window.__planet.getState().solve())
await page.waitForTimeout(1500)

// Probe the scene for Text meshes (drei Text)
const summary = await page.evaluate(() => {
  // Walk the default scene via a known hook
  const app = document.querySelector('canvas')?.parentElement
  // Go through r3f internals (hacky but for debug)
  // Instead, use the fiber state from the canvas.
  const canvas = document.querySelector('canvas')
  if (!canvas) return 'no canvas'
  const root = canvas.__r3f ?? canvas._fiber
  if (!root) {
    // try the R3F getter hanging off the canvas via drei's store access
    return 'no r3f root'
  }
  return 'has root'
})
console.log('probe:', summary)

// Alternative: count Text-like objects via scene traversal via window access
const counts = await page.evaluate(() => {
  const list = []
  function walk(obj, depth=0) {
    if (depth > 12) return
    list.push(`${'  '.repeat(depth)}${obj.type}${obj.name ? ':'+obj.name : ''}${obj.visible ? '' : ' [hidden]'}${obj.position ? ` @(${obj.position.x.toFixed(2)},${obj.position.y.toFixed(2)},${obj.position.z.toFixed(2)})` : ''}`)
    for (const c of obj.children || []) walk(c, depth+1)
  }
  // Find Three scene via window globals? r3f doesn't expose by default.
  // Try a hack: look at THREE via imports — not available here.
  // Use window.__R3F_SCENE if we expose it.
  if (window.__r3fScene) walk(window.__r3fScene)
  return list.join('\n')
})
console.log('scene tree:\n' + (counts || '(need window.__r3fScene hook)'))

await page.screenshot({ path: '/tmp/rubics-test/day7-lab-debug-sphere.png' })
await browser.close()
