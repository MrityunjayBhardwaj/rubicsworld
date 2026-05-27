// Observe issue #75: per-sound "Reset to default" in the audio editor.
//
// Seeds a param edit + ephemeral overrides on a loop via the dev bus hook,
// then drives the REAL Reset button in the UI and asserts every layer is
// restored to the registry.json default: runtime def params, override map.
import { chromium } from 'playwright'

const URL = 'http://localhost:5175/edit/levels/lvl_1/audio'
const KEY = 'theme_music'          // first loop; auto-selected on load
const DEFAULT_BASE = 0.22          // registry.json theme_music.params.vol.base

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('  [page error]', m.text()) })
page.on('dialog', d => d.accept())  // accept the reset confirm()

const results = []
const ok = (label, cond, detail = '') => { results.push({ label, pass: !!cond, detail }); }

await page.goto(URL, { waitUntil: 'domcontentloaded' })

// Wait for the dev bus hook to attach.
await page.waitForFunction(() => !!(window).__audioBus, null, { timeout: 15000 })

// 1. hasRegistryDefault semantics — gates the button's enabled state.
const pre = await page.evaluate((key) => {
  const b = (window).__audioBus
  return {
    hasDefault: b.hasRegistryDefault(key),
    hasDefaultBogus: b.hasRegistryDefault('___nope___'),
  }
}, KEY)
ok('hasRegistryDefault(theme_music) = true', pre.hasDefault === true)
ok('hasRegistryDefault(bogus) = false', pre.hasDefaultBogus === false)

// 2. Seed a param edit + ephemeral overrides (what the UI would produce).
//    Force-register the loop first so the runtime def edit is observable
//    (in the editor a loop may not be in this.loops until first play).
const seeded = await page.evaluate((key) => {
  const b = (window).__audioBus
  const def = b.getLoopRuntimeDef(key) ?? { key, anchor: 'world', src: 'audio/theme.ogg' }
  b.registerLoop({ ...def, params: { ...(def.params ?? {}), vol: { base: 0.99, modulator: 'themeWalkDuck' } } })
  b.setLoopOverride(key, { vol: 0.42, mute: true })
  return { base: b.getLoopRuntimeDef(key)?.params?.vol?.base, override: b.getLoopOverride(key) ?? null }
}, KEY)
ok('seed: runtime base now 0.99', seeded.base === 0.99, `got ${seeded.base}`)
ok('seed: override present', seeded.override && seeded.override.vol === 0.42 && seeded.override.mute === true)

// 3. theme_music is auto-selected on load, so the Inspector already shows it.
//    Click the real Reset button (confirm() auto-accepted by the dialog handler).
const resetBtn = page.getByRole('button', { name: 'Reset to default' })
await resetBtn.waitFor({ state: 'visible', timeout: 10000 })
const disabled = await resetBtn.isDisabled()
ok('reset button enabled for entry with default', disabled === false)
await resetBtn.click()

// 4. Assert every layer restored.
await page.waitForTimeout(400)
const post = await page.evaluate((key) => {
  const b = (window).__audioBus
  return { base: b.getLoopRuntimeDef(key)?.params?.vol?.base, override: b.getLoopOverride(key) ?? null }
}, KEY)
ok('after reset: base back to 0.22', post.base === DEFAULT_BASE, `got ${post.base}`)
ok('after reset: override cleared', post.override === null, `got ${JSON.stringify(post.override)}`)

await browser.close()

console.log('\n=== reset-to-default observation ===\n')
let allPass = true
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.label}${r.detail && !r.pass ? '  (' + r.detail + ')' : ''}`)
  if (!r.pass) allPass = false
}
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
