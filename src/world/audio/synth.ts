// Lightweight WebAudio synth for one-shot SFX. Each function takes the
// AudioContext + an output GainNode and schedules a single voice that
// frees itself on completion. Voices are independent — overlapping calls
// do not steal each other.

type SynthFn = (ctx: AudioContext, out: AudioNode) => void

export interface SynthLoopHandle {
  source: AudioNode  // node to connect to a downstream gain (loop's per-loop gain)
  stop: () => void
  // Optional named AudioParams the bus can modulate from registry param
  // bindings. Common keys: `oscFreq` (oscillator frequency), `bandpass`
  // / `lowpass` / `highpass` (filter cutoffs), `lfoFreq` (modulator rate).
  params?: Record<string, AudioParam>
}
export type SynthLoopFn = (ctx: AudioContext) => SynthLoopHandle

// Short tick — square wave, snappy envelope. Used on every 6.5° threshold
// cross during a slice drag.
const click: SynthFn = (ctx, out) => {
  const t0 = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = 'square'
  osc.frequency.setValueAtTime(900, t0)
  osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.04)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(0.18, t0 + 0.003)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05)
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.06)
}

// Soft two-note bell. Used when a slice eases into committed alignment.
const chime: SynthFn = (ctx, out) => {
  const t0 = ctx.currentTime
  const fundamentals = [523.25, 1046.5]  // C5 + C6
  fundamentals.forEach((f, i) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(f, t0)
    const g = ctx.createGain()
    const peak = i === 0 ? 0.22 : 0.12
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(peak, t0 + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9)
    osc.connect(g).connect(out)
    osc.start(t0)
    osc.stop(t0 + 0.95)
  })
}

// Short pad blip — filtered noise, ~80ms. Used per ~0.5m of walk distance.
const footstep: SynthFn = (ctx, out) => {
  const t0 = ctx.currentTime
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
  const src = ctx.createBufferSource()
  src.buffer = buf
  const filt = ctx.createBiquadFilter()
  filt.type = 'lowpass'
  filt.frequency.setValueAtTime(800, t0)
  filt.Q.value = 0.7
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(0.12, t0 + 0.005)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09)
  src.connect(filt).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.1)
}

// Rising pitch sine, ~120ms. One-shot on Space.
const jump: SynthFn = (ctx, out) => {
  const t0 = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(280, t0)
  osc.frequency.exponentialRampToValueAtTime(620, t0 + 0.12)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(0.18, t0 + 0.01)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14)
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.16)
}

export const SYNTHS: Record<string, SynthFn> = {
  click,
  chime,
  footstep,
  jump,
}

// ── Continuous synth loops (commit 3+) ──────────────────────────────────
// Each builds a WebAudio graph that runs forever; the bus owns a per-loop
// GainNode on the consumer side, so these only expose `source` (the final
// node before that gain) and `stop()` for teardown.

function makeNoiseBuffer(ctx: AudioContext, seconds = 4): AudioBuffer {
  // Pink-ish noise via simple low-pass averaging over white noise. Cheap;
  // one ~4s buffer played in a loop is ~700kb in memory but zero on disk.
  const len = ctx.sampleRate * seconds
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    last = last * 0.85 + w * 0.15
    data[i] = last
  }
  return buf
}

// Outdoor ambient wind — soft, low-shelved noise with slow gain LFO so the
// layer breathes rather than droning at constant level.
//
// Exposed params:
//   `lowpass`  — filter cutoff Hz (open as wind strength rises)
//   `lfoFreq`  — breathing rate Hz
const windAmbient: SynthLoopFn = (ctx) => {
  const src = ctx.createBufferSource()
  src.buffer = makeNoiseBuffer(ctx, 5)
  src.loop = true
  const filt = ctx.createBiquadFilter()
  filt.type = 'lowpass'
  filt.frequency.value = 600
  filt.Q.value = 0.4
  const breathe = ctx.createGain()
  breathe.gain.value = 1.0
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 0.07
  const lfoGain = ctx.createGain()
  lfoGain.gain.value = 0.3
  lfo.connect(lfoGain).connect(breathe.gain)
  src.connect(filt).connect(breathe)
  src.start()
  lfo.start()
  return {
    source: breathe,
    stop: () => { try { src.stop() } catch { /* ignore */ } try { lfo.stop() } catch { /* ignore */ } },
    params: { lowpass: filt.frequency, lfoFreq: lfo.frequency },
  }
}

// Wind-cutting layer — narrower band, brighter, modulator-driven. Volume is
// near 0 at rest; the bus ramps it up as cameraOrbitSpeed climbs.
//
// Exposed params:
//   `bandpass` — bandpass center Hz (pitch up with camera speed for the
//                "wind in your ears" effect)
//   `highpass` — bottom-end roll-off
const windCut: SynthLoopFn = (ctx) => {
  const src = ctx.createBufferSource()
  src.buffer = makeNoiseBuffer(ctx, 4)
  src.loop = true
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 500
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1400
  bp.Q.value = 0.9
  src.connect(hp).connect(bp)
  src.start()
  return {
    source: bp,
    stop: () => { try { src.stop() } catch { /* ignore */ } },
    params: { bandpass: bp.frequency, highpass: hp.frequency },
  }
}

// Toy-car engine — stylised, looping low square + sub. PositionalAudio
// handles distance falloff. Engine pitch tracks RPM via the `oscFreq`
// param; sub2 is locked at 1.5× via detune to keep the chord stable as
// the fundamental moves.
//
// Exposed params:
//   `oscFreq`  — fundamental frequency Hz (engine RPM)
//   `lowpass`  — filter cutoff (open up as the engine works harder)
//   `lfoFreq`  — detune-wobble rate
const carEngine: SynthLoopFn = (ctx) => {
  // Master pitch lives on a ConstantSource so both oscillators track one
  // value when the bus writes `oscFreq`. sub plays at fundamental Hz; sub2
  // plays at fundamental × 1.5 (perfect fifth) for a chunky engine chord.
  const fundamental = ctx.createConstantSource()
  fundamental.offset.value = 70

  const sub = ctx.createOscillator()
  sub.type = 'square'
  sub.frequency.value = 0  // additive — receives all freq from fundamental
  fundamental.connect(sub.frequency)

  const sub2 = ctx.createOscillator()
  sub2.type = 'sawtooth'
  sub2.frequency.value = 0
  const fifthScale = ctx.createGain()
  fifthScale.gain.value = 1.5
  fundamental.connect(fifthScale).connect(sub2.frequency)

  // Slow detune wobble so it doesn't sit perfectly still.
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 4.5
  const lfoGain = ctx.createGain()
  lfoGain.gain.value = 6
  lfo.connect(lfoGain).connect(sub2.detune)

  const filt = ctx.createBiquadFilter()
  filt.type = 'lowpass'
  filt.frequency.value = 600
  filt.Q.value = 1.2
  const mix = ctx.createGain()
  mix.gain.value = 0.5
  sub.connect(filt).connect(mix)
  sub2.connect(filt)

  fundamental.start()
  sub.start()
  sub2.start()
  lfo.start()
  return {
    source: mix,
    stop: () => {
      try { sub.stop() } catch { /* ignore */ }
      try { sub2.stop() } catch { /* ignore */ }
      try { lfo.stop() } catch { /* ignore */ }
      try { fundamental.stop() } catch { /* ignore */ }
    },
    params: { oscFreq: fundamental.offset, lowpass: filt.frequency, lfoFreq: lfo.frequency },
  }
}

// Windmill whoosh — bandpass-filtered noise modulated by a slow LFO that
// matches the blade-pass cadence (4 blades × ω/2π Hz with ω≈0.8 rad/s ⇒
// ~0.5 Hz). The result reads as a soft rhythmic "whoosh-whoosh".
//
// Exposed params:
//   `lfoFreq`  — whoosh rate Hz (tracks blade rotation if you want it
//                to vary; current windmill spins at constant 0.8 rad/s)
//   `bandpass` — color of the whoosh
const windmillWhoosh: SynthLoopFn = (ctx) => {
  const src = ctx.createBufferSource()
  src.buffer = makeNoiseBuffer(ctx, 4)
  src.loop = true
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 700
  bp.Q.value = 1.4
  const am = ctx.createGain()
  am.gain.value = 0.1
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.5
  const lfoDepth = ctx.createGain()
  lfoDepth.gain.value = 0.4
  lfo.connect(lfoDepth).connect(am.gain)
  src.connect(bp).connect(am)
  src.start()
  lfo.start()
  return {
    source: am,
    stop: () => { try { src.stop() } catch { /* ignore */ } try { lfo.stop() } catch { /* ignore */ } },
    params: { lfoFreq: lfo.frequency, bandpass: bp.frequency },
  }
}

// Grass swipe — soft pink noise through a bandpass that opens with cursor
// speed. At rest the layer is muted via vol; when intensity rises the
// bandpass sweeps up so the timbre brightens with the gesture rather than
// just getting louder.
//
// Exposed params:
//   `bandpass` — center freq Hz (sweep up with cursor velocity)
//   `lowpass`  — top-end roll-off
const grassSwipe: SynthLoopFn = (ctx) => {
  const src = ctx.createBufferSource()
  src.buffer = makeNoiseBuffer(ctx, 3)
  src.loop = true
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1500
  bp.Q.value = 1.6
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 4000
  src.connect(bp).connect(lp)
  src.start()
  return {
    source: lp,
    stop: () => { try { src.stop() } catch { /* ignore */ } },
    params: { bandpass: bp.frequency, lowpass: lp.frequency },
  }
}

// Bird-flock chirp ensemble — randomly scheduled short FM blips at three
// pitches. Loops forever; each blip is a quick frequency slide on a sine
// with a snappy AD envelope. Crude but pleasant on small mono speakers.
const birdsFlock: SynthLoopFn = (ctx) => {
  const out = ctx.createGain()
  out.gain.value = 1.0
  let stopped = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  const fundamentals = [2400, 3200, 2000]

  const scheduleNext = () => {
    if (stopped) return
    const wait = 250 + Math.random() * 700  // 0.25–0.95s between chirps
    timeout = setTimeout(() => {
      const f = fundamentals[Math.floor(Math.random() * fundamentals.length)]
      const t0 = ctx.currentTime
      const dur = 0.05 + Math.random() * 0.08
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(f * 0.85, t0)
      osc.frequency.linearRampToValueAtTime(f * 1.15, t0 + dur * 0.4)
      osc.frequency.linearRampToValueAtTime(f * 0.95, t0 + dur)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(0.18, t0 + 0.005)
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
      osc.connect(g).connect(out)
      osc.start(t0)
      osc.stop(t0 + dur + 0.01)
      scheduleNext()
    }, wait)
  }
  scheduleNext()

  return {
    source: out,
    stop: () => {
      stopped = true
      if (timeout) clearTimeout(timeout)
    },
  }
}

export const SYNTH_LOOPS: Record<string, SynthLoopFn> = {
  windAmbient,
  windCut,
  carEngine,
  windmillWhoosh,
  birdsFlock,
  grassSwipe,
}
