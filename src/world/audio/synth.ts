// Lightweight WebAudio synth for one-shot SFX. Each function takes the
// AudioContext + an output GainNode and schedules a single voice that
// frees itself on completion. Voices are independent — overlapping calls
// do not steal each other.

type SynthFn = (ctx: AudioContext, out: AudioNode) => void

export interface SynthLoopHandle {
  source: AudioNode  // node to connect to a downstream gain (loop's per-loop gain)
  stop: () => void
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
  // LFO: 0.07 Hz with ±0.3 amplitude around 1.0.
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
  }
}

// Wind-cutting layer — narrower band, brighter, modulator-driven. Volume is
// near 0 at rest; the bus ramps it up as cameraOrbitSpeed climbs.
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
  }
}

// Toy-car engine — stylised, looping low square + sub. Ramps slightly with
// PositionalAudio distance falloff handled by the bus.
const carEngine: SynthLoopFn = (ctx) => {
  const sub = ctx.createOscillator()
  sub.type = 'square'
  sub.frequency.value = 70
  const sub2 = ctx.createOscillator()
  sub2.type = 'sawtooth'
  sub2.frequency.value = 105
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
  sub.start()
  sub2.start()
  lfo.start()
  return {
    source: mix,
    stop: () => {
      try { sub.stop() } catch { /* ignore */ }
      try { sub2.stop() } catch { /* ignore */ }
      try { lfo.stop() } catch { /* ignore */ }
    },
  }
}

export const SYNTH_LOOPS: Record<string, SynthLoopFn> = {
  windAmbient,
  windCut,
  carEngine,
}
