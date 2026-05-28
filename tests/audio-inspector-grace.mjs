// Observe #84: clicking a list row routes through `selectManually` which
// updates BOTH the selection AND the grace timestamp (`lastInteractRef`).
// The full timing behavior (grace blocking scene auto-publishes for 3 s)
// is verified by code review — Playwright + the live WebGL scene make
// each `evaluate` round-trip several wall-clock seconds long, so any
// timing-sensitive assertion is unreliable.
//
// What this test proves (regression guard for #84):
//   - Row click flips selection (the existing onSelect path works).
//   - The grace timestamp goes from 0 (initial) to a finite positive number
//     in the same tick — proving the selectManually wiring is in place,
//     not the older bare setSelectedKey.
import { chromium } from 'playwright'

const URL = 'http://localhost:7001/edit/levels/lvl_1/audio'

const results = []
const ok = (label, cond, detail = '') => results.push({ label, pass: !!cond, detail })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(
  () => !!(window).__audioEditor,
  null, { timeout: 15000 },
)
await page.waitForTimeout(1200)

const beforeTs = await page.evaluate(() => (window).__audioEditor.lastInteractAt())
ok('grace timestamp is 0 before any interaction', beforeTs === 0, `got ${beforeTs}`)

await page.evaluate(() => {
  const row = [...document.querySelectorAll('div')].find(d => {
    const c = d.children
    return c.length === 2 && c[0]?.tagName === 'SPAN' && c[1]?.tagName === 'SPAN'
        && c[0].textContent === 'EVT' && c[1].textContent === 'footstep'
  })
  row?.click()
})

const inspKey = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Replace sample…')
  let pane = btn?.parentElement
  while (pane && pane.parentElement && getComputedStyle(pane).overflowY !== 'auto') pane = pane.parentElement
  return pane?.children?.[0]?.textContent?.trim().replace(/Reset to default$/, '') ?? null
})
ok('row click flips selection to footstep', inspKey === 'footstep', `got ${inspKey}`)

const afterTs = await page.evaluate(() => (window).__audioEditor.lastInteractAt())
ok('row click bumped grace timestamp (selectManually wired)',
   afterTs > 0 && afterTs !== beforeTs, `before=${beforeTs} after=${afterTs}`)

await browser.close()

console.log('\n=== inspector interaction grace — wiring guard ===\n')
let allPass = true
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.label}${!r.pass && r.detail ? '  (' + r.detail + ')' : ''}`)
  if (!r.pass) allPass = false
}
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
