// Observe issue #75 acceptance: reset → commit DROPS the entry from audio.json.
//
// Seed an override on a loop, Commit (entry appears in audio.json), Reset,
// Commit again (entry gone). Proves reset escapes the persisted override —
// not just the live state. Cleans up the created audio.json afterward.
import { chromium } from 'playwright'
import { readFileSync, existsSync, rmSync } from 'node:fs'

const BASE = 'http://localhost:5175'
const URL = `${BASE}/edit/levels/lvl_1/audio`
const KEY = 'theme_music'
const AUDIO_JSON = 'public/levels/lvl_1/audio.json'

const results = []
const ok = (label, cond, detail = '') => results.push({ label, pass: !!cond, detail })
const readJson = () => existsSync(AUDIO_JSON) ? JSON.parse(readFileSync(AUDIO_JSON, 'utf8')) : null
const hasKey = (j) => !!j && [...(j.loops ?? []), ...(j.events ?? [])].some(e => e.key === KEY)

// Start clean.
if (existsSync(AUDIO_JSON)) rmSync(AUDIO_JSON)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!(window).__audioBus, null, { timeout: 15000 })
await page.getByRole('button', { name: 'Reset to default' }).waitFor({ state: 'visible', timeout: 10000 })

// Helpers: dispatch the REAL React onClick programmatically. A synthetic
// mouse click is flaky once the WebGL scene is hammering the compositor
// (test audio-reset-default.mjs already proves a real click works); here we
// only need the handler to run. Stub confirm() so Reset proceeds.
await page.evaluate(() => { window.confirm = () => true })
const clickByText = (txt) => page.evaluate((t) => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === t)
  if (!el) throw new Error(`button not found: ${t}`)
  el.click()
}, txt)

// 1. Seed an override and Commit → entry should land in audio.json.
await page.evaluate((key) => (window).__audioBus.setLoopOverride(key, { vol: 0.5, mute: true }), KEY)
await clickByText('Commit Audio')
await page.waitForTimeout(700)
const afterEdit = readJson()
ok('after edit+commit: audio.json contains theme_music', hasKey(afterEdit),
   `loops=${JSON.stringify(afterEdit?.loops?.map(l => l.key))}`)

// 2. Reset, then Commit again → entry should be gone.
await clickByText('Reset to default')
await page.waitForTimeout(400)
await clickByText('Commit Audio')
await page.waitForTimeout(700)
const afterReset = readJson()
ok('after reset+commit: theme_music dropped from audio.json', !hasKey(afterReset),
   `loops=${JSON.stringify(afterReset?.loops?.map(l => l.key))}`)

await browser.close()

// Cleanup — leave the tree as we found it.
if (existsSync(AUDIO_JSON)) rmSync(AUDIO_JSON)

console.log('\n=== reset → commit-drop observation ===\n')
let allPass = true
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.label}${!r.pass && r.detail ? '  (' + r.detail + ')' : ''}`)
  if (!r.pass) allPass = false
}
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
