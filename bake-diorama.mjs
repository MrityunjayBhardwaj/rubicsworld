// Drives the running dev server's /bake/ route to bake the imperative
// diorama → public/diorama.glb. The /bake/ page mounts a non-rendering
// React tree and runs the bake on first effect — sidesteps the headless
// 24-pass sphere stall because nothing actually renders.
import { chromium } from 'playwright'

const URL_BASE = 'http://localhost:5173/bake/'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } })
const page = await ctx.newPage()
page.on('console', msg => {
  const t = msg.type()
  const txt = msg.text()
  if (t === 'error' || txt.startsWith('[diorama]') || txt.startsWith('[grass]') || txt.startsWith('[bake]')) {
    console.log(`[browser:${t}]`, txt)
  }
})
page.on('pageerror', err => console.log('[pageerror]', err.message))

console.log('Loading', URL_BASE)
await page.goto(URL_BASE, { waitUntil: 'load', timeout: 30000 })

console.log('Waiting for bake to finish …')
let last = null
for (let i = 0; i < 60; i++) {
  const txt = await page.locator('#bake-status').textContent().catch(() => null)
  if (txt) {
    try {
      last = JSON.parse(txt)
    } catch { /* ignore parse blip */ }
  }
  if (last?.phase === 'done' || last?.phase === 'error') break
  if (i % 3 === 0) console.log(`  [${i}s]`, last?.phase ?? '(no status)')
  await new Promise(r => setTimeout(r, 1000))
}

console.log('Final status:', JSON.stringify(last, null, 2))
await browser.close()
process.exit(last?.phase === 'done' ? 0 : 1)
