// End-to-end audio format decode check.
//
// The whole audio pipeline (accept attr → /__audio/upload → audio.json →
// THREE.AudioLoader → context.decodeAudioData) is format-agnostic: the ONLY
// step that cares about the codec is the browser's decodeAudioData. This test
// drives that exact choke point in every engine the project might run in.
//
// We pass the raw bytes into the page as base64 and call decodeAudioData
// directly — byte-identical to what AudioLoader hands the decoder after fetch.
import { chromium, firefox, webkit } from 'playwright'
import { readFileSync } from 'node:fs'

const FIXTURES = {
  'wav (pcm)':   '/tmp/sfx_test.wav',
  'mp3':         '/tmp/sfx_test.mp3',
  'ogg (opus)':  '/tmp/sfx_test.ogg',          // matches the repo's actual codec
  'ogg (vorbis-named, real repo file)': '/tmp/sfx_real_vorbis.ogg',
}

const b64 = Object.fromEntries(
  Object.entries(FIXTURES).map(([k, p]) => [k, readFileSync(p).toString('base64')]),
)

async function testEngine(name, launcher) {
  let browser
  try {
    browser = await launcher.launch({ headless: true })
  } catch (e) {
    return { name, skipped: `launch failed: ${e.message}` }
  }
  const page = await browser.newPage()
  const results = await page.evaluate(async (samples) => {
    const out = {}
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return { _error: 'no AudioContext' }
    const ctx = new Ctx()
    for (const [label, b64str] of Object.entries(samples)) {
      const bin = atob(b64str)
      const buf = new ArrayBuffer(bin.length)
      const view = new Uint8Array(buf)
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
      try {
        // decodeAudioData detaches the buffer; clone per attempt.
        const ab = await ctx.decodeAudioData(buf.slice(0))
        out[label] = { ok: true, sec: +ab.duration.toFixed(3), ch: ab.numberOfChannels, hz: ab.sampleRate }
      } catch (err) {
        out[label] = { ok: false, err: String(err && err.message || err) }
      }
    }
    await ctx.close()
    return out
  }, b64)
  await browser.close()
  return { name, results }
}

const engines = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]
const all = []
for (const [n, l] of engines) all.push(await testEngine(n, l))

console.log('\n=== decodeAudioData format matrix ===\n')
for (const e of all) {
  if (e.skipped) { console.log(`${e.name}: SKIPPED (${e.skipped})\n`); continue }
  console.log(`${e.name}:`)
  for (const [label, r] of Object.entries(e.results)) {
    if (label === '_error') { console.log(`  ERROR: ${r}`); continue }
    console.log(r.ok
      ? `  ✓ ${label.padEnd(38)} ${r.sec}s ${r.ch}ch ${r.hz}Hz`
      : `  ✗ ${label.padEnd(38)} ${r.err}`)
  }
  console.log('')
}
