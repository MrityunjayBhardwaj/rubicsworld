// Observe #74: bus.loadBuffer retries the .mp3 sibling on .ogg decode failure.
//
// We can't easily reproduce a real Safari decode failure in headless
// Chrome (Chrome decodes .ogg fine), so we simulate it: replace the bus's
// THREE.AudioLoader.load with a stub that fails for any .ogg url and
// succeeds for .mp3. Then trigger a sound that's defined as .ogg in the
// registry and observe:
//   1. mp3 sibling exists on disk (HEAD probe)
//   2. The bus's bufferCache ends up with a SUCCESSFUL buffer for the
//      .ogg key (because the fallback resolved)
//   3. Console "trying mp3 fallback" info message fires
//
// Also verify the happy path (.ogg works first try, no mp3 fetch) hasn't
// regressed.
import { chromium } from 'playwright'

const URL = 'http://localhost:7001/edit/levels/lvl_1/audio'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const consoles = []
page.on('console', msg => consoles.push(msg.type() + ': ' + msg.text()))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!(window).__audioBus, null, { timeout: 15000 })
await page.waitForFunction(() => {
  const b = (window).__audioBus
  return !!b && !!b.sfxGain
}, null, { timeout: 10000 })

// ── Probe 1: mp3 fixtures are on disk ──
const mp3Probe = await page.evaluate(async () => {
  const urls = ['/audio/theme.mp3', '/audio/footstep_grass.mp3', '/audio/pond.mp3']
  const out = {}
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'HEAD' })
      out[u] = { ok: r.ok, status: r.status, size: r.headers.get('content-length') }
    } catch (e) { out[u] = { error: String(e) } }
  }
  return out
})

// ── Probe 2: happy path — load a fresh .ogg, peak should populate ──
// (theme is loaded at bus boot already; use a sample we KNOW the editor's
// WaveformCanvas hasn't touched yet — there isn't one really, but we can
// at least observe the bus state.)
await page.evaluate(async () => {
  await (window).__audioBus.loadSampleBuffer('audio/theme.ogg').catch(() => {})
})
await page.waitForFunction(
  () => (window).__audioBus?.peakCoefficients?.get('/audio/theme.ogg') != null,
  null, { timeout: 8000 },
).catch(() => {})
const happyPath = await page.evaluate(() => ({
  themeCoef: (window).__audioBus.peakCoefficients?.get('/audio/theme.ogg'),
  themeCached: (window).__audioBus.bufferCache?.has('/audio/theme.ogg'),
}))

// ── Probe 3: forced Safari simulation. Replace audioLoader.load so .ogg
//    fetches reject. Clear caches for a fresh load. Trigger via
//    loadSampleBuffer for a sample the editor hasn't touched yet (axis_rotation).
const fallback = await page.evaluate(async () => {
  const bus = (window).__audioBus
  // Clear caches so the next load actually hits audioLoader.load.
  bus.bufferCache.clear()
  bus.peakCoefficients.clear()
  // Monkey-patch audioLoader.load: reject .ogg with a synthetic
  // DOMException matching Safari's "Decoding failed" shape, succeed .mp3
  // by delegating to the original loader.
  const orig = bus.audioLoader.load.bind(bus.audioLoader)
  let mp3CallCount = 0
  let oggCallCount = 0
  bus.audioLoader.load = (url, onLoad, onProgress, onError) => {
    if (/\.ogg$/i.test(url)) {
      oggCallCount++
      // Defer rejection to next tick so it's properly async — matches
      // how AudioLoader handles decodeAudioData errors.
      setTimeout(() => onError(new Error('simulated Safari Opus decode failure')), 10)
      return
    }
    mp3CallCount++
    return orig(url, onLoad, onProgress, onError)
  }
  let resolveErr = null
  let buf = null
  try {
    buf = await bus.loadSampleBuffer('audio/axis_rotation.ogg')
  } catch (e) {
    resolveErr = String(e)
  }
  return {
    oggCallCount,
    mp3CallCount,
    bufferOk: !!buf && buf.numberOfChannels > 0,
    bufferChannels: buf?.numberOfChannels,
    bufferDuration: buf?.duration,
    resolveErr,
  }
})

await browser.close()

const ok1 = mp3Probe['/audio/theme.mp3']?.ok === true
const ok2 = mp3Probe['/audio/footstep_grass.mp3']?.ok === true
const ok3 = mp3Probe['/audio/pond.mp3']?.ok === true
const ok4 = happyPath.themeCoef > 0 && happyPath.themeCached
const ok5 = fallback.oggCallCount === 1            // .ogg tried first
const ok6 = fallback.mp3CallCount === 1            // .mp3 fallback tried exactly once
const ok7 = fallback.bufferOk                       // we got a real AudioBuffer back
const ok8 = consoles.some(c => /trying mp3 fallback/.test(c))

console.log('\n=== audio mp3 fallback observation ===\n')
console.log('  mp3 probe:', mp3Probe)
console.log('  happy path:', happyPath)
console.log('  fallback:', fallback)
console.log()
console.log(`  ${ok1 ? '✓' : '✗'} /audio/theme.mp3 served by dev server`)
console.log(`  ${ok2 ? '✓' : '✗'} /audio/footstep_grass.mp3 served`)
console.log(`  ${ok3 ? '✓' : '✗'} /audio/pond.mp3 served`)
console.log(`  ${ok4 ? '✓' : '✗'} happy path: .ogg loads + peak cached`)
console.log(`  ${ok5 ? '✓' : '✗'} fallback: bus tried .ogg first (got ${fallback.oggCallCount}, expected 1)`)
console.log(`  ${ok6 ? '✓' : '✗'} fallback: bus tried .mp3 after .ogg failure (got ${fallback.mp3CallCount}, expected 1)`)
console.log(`  ${ok7 ? '✓' : '✗'} fallback: AudioBuffer returned (channels=${fallback.bufferChannels}, duration=${fallback.bufferDuration?.toFixed(2)}s)`)
console.log(`  ${ok8 ? '✓' : '✗'} fallback: console "trying mp3 fallback" message emitted`)
const allPass = ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8
console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES PRESENT'}\n`)
process.exit(allPass ? 0 : 1)
