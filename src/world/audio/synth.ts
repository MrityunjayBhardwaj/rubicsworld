// Lightweight WebAudio synth for one-shot SFX. Each function takes the
// AudioContext + an output GainNode and schedules a single voice that
// frees itself on completion. Voices are independent — overlapping calls
// do not steal each other.

type SynthFn = (ctx: AudioContext, out: AudioNode) => void

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
