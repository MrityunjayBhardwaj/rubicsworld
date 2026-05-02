// Drives the running dev server's /bake/ route to process public/diorama.glb
// in place — load, dedupe materials, weld cube-net seams, recompute terrain
// normals, write back. Non-destructive: source and target are the same file.
//
// Why a browser at all: three.js GLTFLoader needs DOM globals (atob, btoa,
// document.baseURI), so server-side Node round-trip isn't viable. Headless
// Chromium with the dev server is the simplest cross-platform path.
//
// CDP Network domain is disabled before navigation. The in-page POST of the
// baked glb (~100 MB on a real Blender export) generates Network.requestWillBeSent
// events that include the request body inline; Playwright's PipeTransport
// concatenates those into a single string and overflows V8's 512 MB
// max-string-length. With Network.disable, those events are suppressed and
// the POST traverses the network without traversing CDP.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5173'
const URL_BASE = `http://localhost:${PORT}/bake/`

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } })
const page = await ctx.newPage()

// Disable CDP Network domain so the 100 MB POST body doesn't blow up the
// IPC transport. Page-level fetch still works — only the CDP observer
// pipeline is silenced.
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.disable').catch(() => { /* already disabled is fine */ })

page.on('console', msg => {
  const t = msg.type()
  const txt = msg.text()
  if (t === 'error' || txt.startsWith('[diorama]') || txt.startsWith('[grass]') || txt.startsWith('[bake]')) {
    console.log(`[browser:${t}]`, txt.slice(0, 400))
  }
})
page.on('pageerror', err => console.log('[pageerror]', err.message?.slice(0, 400)))

console.log('Loading', URL_BASE)
await page.goto(URL_BASE, { waitUntil: 'load', timeout: 30000 })

console.log('Waiting for bake to finish …')
let last = null
for (let i = 0; i < 120; i++) {
  const txt = await page.evaluate(() => document.getElementById('bake-status')?.textContent ?? null).catch(() => null)
  if (txt) { try { last = JSON.parse(txt) } catch { /* ignore parse blip */ } }
  if (last?.phase === 'done' || last?.phase === 'error') break
  if (i % 3 === 0) console.log(`  [${i}s]`, last?.phase ?? '(no status)')
  await new Promise(r => setTimeout(r, 1000))
}

console.log('Final status:', JSON.stringify(last, null, 2))
await browser.close()
process.exit(last?.phase === 'done' ? 0 : 1)
