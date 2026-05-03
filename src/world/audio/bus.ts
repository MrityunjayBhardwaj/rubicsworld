// Audio bus — single AudioListener attached to the camera, registry-driven
// loops + events, anchor lookup by id (Object3D refs registered from the
// scene), modulators that map per-frame state to 0..1 gain factors.
//
// Three's Audio + PositionalAudio handle distance falloff, listener-relative
// pan, AudioContext lifecycle. We add: lazy-attach when an anchor isn't
// registered yet; modulator tick; master/category mute & volume.

import * as THREE from 'three'
import { SYNTHS, SYNTH_LOOPS, type SynthLoopHandle } from './synth'
import { cubeNetToSphere } from './sphereProject'
import { useLastTriggered } from './lastTriggered'

export type AnchorRef = 'world' | 'camera_motion' | `object:${string}`

// Per-param binding spec. `base × modulator` is the simple knob (volume,
// playbackRate). `min`/`max` enables remapping the modulator's 0..1 range
// to absolute values (e.g. mapping `cameraOrbitSpeed` 0..1 to lowpass
// 800..22000 Hz). `invert: true` flips the mapping (modulator=1 maps to
// min, modulator=0 maps to max — useful for filters that should *close*
// as a metric drops).
export interface ParamSpec {
  base?: number
  modulator?: string | string[]
  min?: number
  max?: number
  invert?: boolean
  // Filter resonance — only meaningful for lowpass/highpass/bandpass
  // params. Default 0.7 (transparent in lowpass, gentle peak in
  // bandpass). Higher Q = narrower filter, more emphasis at cutoff.
  // Read at applyParams time so the editor's Q slider takes effect on
  // next tick without rebuilding the BiquadFilter.
  q?: number
}

// Re-export so the editor can construct/mutate specs without poking the
// shape via 'any'. ParamSpec was already exported above; this is just a
// readability anchor for downstream editor code.
export type { ParamSpec as LoopParamSpec }

/**
 * Volume envelope baked from a Blender Speaker's keyframed `.volume`
 * property. The runtime samples it per frame against an external clock —
 * usually the diorama's AnimationMixer time so audio stays sync'd with
 * visual animation. fps lets the runtime convert clock seconds → sample
 * index. Looped against `samples.length / fps` (so a 3 s envelope at 60 fps
 * holds 180 entries and loops every 3 s).
 */
export interface VolumeEnvelope {
  fps: number
  samples: number[]
}

export interface LoopDef {
  key: string
  anchor: AnchorRef
  src: string
  /** Convolution kernel — Bézier-curve impulse response (#65). For
   *  loops the kernel applies serially through setFilters; the wet
   *  factor scales the kernel buffer values, which acts as dry/wet
   *  mix only if the curve carries an impulse at t=0. */
  kernel?: KernelSpec
  // New shape: per-param bindings. Common keys:
  //   `vol`     — volume (sample loops via setVolume; synth 2D via synthGain;
  //               synth POSITIONAL via positional setVolume)
  //   `rate`    — playbackRate for sample loops; OR synth's exposed AudioParam
  //               named `rate` if defined by the synth handle
  //   any other — must match a name in synth handle's exposed params
  //               (e.g. `oscFreq`, `lowpass`, `bandpass`)
  params?: Record<string, ParamSpec>
  // Legacy shorthand: vol + modulator are auto-promoted to params.vol on load.
  vol?: number
  modulator?: string | string[]
  refDist?: number
  maxDist?: number
  rolloff?: number
  // Convenience: if `radius` is set, the bus configures the underlying
  // PositionalAudio with refDist=0, maxDist=radius, rolloff=1 → smooth
  // linear falloff from full gain at the source to zero at the radius.
  // Visualised as a wireframe reach sphere by SoundVisualizer.
  radius?: number
  // Baked Speaker.volume animation. When present, the runtime multiplies
  // envelope[time] into the loop's gain on each tick. Authored entirely
  // in Blender; not present for non-glb-imported loops.
  envelope?: VolumeEnvelope
}
export interface EventDef {
  key: string
  anchor: AnchorRef
  src: string                // 'synth:<name>' or 'audio/<file>.ogg'
  pitchJitter?: number       // ± playbackRate variation for sample one-shots
  // Maximum simultaneous voices. Each new play() while at the cap
  // stops the OLDEST source (FIFO voice stealing), so the texture stays
  // tidy even when triggers fire faster than the sample's duration.
  // Undefined = unlimited (legacy behaviour). Sample events only —
  // synth: voices ignore this for now (they're fire-and-forget).
  polyphony?: number
  /** Convolution kernel — Bézier-curve-defined impulse response (#65). */
  kernel?: KernelSpec
}

/**
 * Convolution kernel specified by a single cubic Bézier curve in
 * normalised [0..1]² space (x = time progress 0..1, y = amplitude
 * 0..1). The bus samples the curve at `taps` points, multiplies by
 * exp(-decay × t) so the IR doesn't hum forever, and packs the result
 * into a single-channel AudioBuffer fed to a ConvolverNode.
 *
 * Why Bézier (not raw sample list): two anchors + two handles is the
 * intuitive "draw an attack/decay shape" UI. Storing 4 points (8
 * floats) commits a tiny audio.json footprint vs. dumping a 256-sample
 * array per entry.
 */
export interface KernelSpec {
  /** Bézier endpoints + control points, all in [0..1]². */
  p1:  [number, number]
  cp1: [number, number]
  cp2: [number, number]
  p2:  [number, number]
  /** Number of samples in the impulse response. Higher = longer tail
   *  + more CPU. 256 ≈ 5.8ms @ 44.1kHz; 1024 ≈ 23ms. Capped at 1024
   *  in the editor — longer IRs go through dedicated reverb. */
  taps: number
  /** Exponential decay rate applied to the curve so the kernel naturally
   *  fades. 0 = no decay (raw curve). Larger = faster fade. */
  decay: number
  /** Output gain on the convolver branch. 0 disables; 1 = full kernel.
   *  For events this sums with a parallel dry branch (so 0 = clean
   *  signal, 1 = fully convolved). For loops the kernel is serial-
   *  only — wet scales the kernel buffer values directly, which acts
   *  as a dry/wet mix when the curve has an impulse near t=0. */
  wet: number
}
export interface Registry {
  loops: LoopDef[]
  events: EventDef[]
}

export type Category = 'master' | 'ambient' | 'sfx'

// Live mirror — same shape as registry.json, but with per-level overrides
// merged in at boot AND mutable at runtime so the audio editor (issue #51)
// can adjust params/swap samples and have the bus pick changes up on the
// next tick. External consumers (panels, audioSettings) keep importing
// REGISTRY; the alias keeps that surface stable.
//
// Circular-import guard: bus.ts → audioLive.ts → bus.ts (for the Registry
// type). Type-only re-import means no runtime cycle. The runtime value
// (`audioLive`) is read on demand below, so the import resolves after both
// modules' bodies have finished.
import { audioLive } from './audioLive'
export const REGISTRY: Registry = audioLive

type Modulator = () => number

// Per-frame writes need to ramp at audio rate, not step at frame rate.
//
// setTargetAtTime is an unbounded exponential — repeatedly cancel-and-
// restarting it at frame boundaries fights with itself (Chromium has a
// known issue where overlapping setTargetAtTime calls produce subtle
// glitches). The clean pattern is:
//
//   cancelAndHoldAtTime(now)            ← preserve in-flight value
//   linearRampToValueAtTime(target, now + horizon)  ← deterministic ramp
//
// horizon is a small lead time (~33ms) so the ramp completes by the next
// expected frame even at 30fps. cancelAndHoldAtTime is widely supported
// in modern browsers; cancelScheduledValues is the fallback (loses the
// in-flight value but still better than direct .value =).
const SMOOTH_HORIZON_GAIN = 1 / 30
const SMOOTH_HORIZON_RATE = 1 / 20   // pitch sweeps want a touch slower
const SMOOTH_HORIZON_FILT = 1 / 25   // filter sweeps audibly chirp if too fast
const lastWriteCache = new WeakMap<AudioParam, number>()
function smoothSet(param: AudioParam | undefined, target: number, ctx: AudioContext, horizon = SMOOTH_HORIZON_GAIN) {
  if (!param || !Number.isFinite(target)) return
  // Web Audio doesn't deduplicate automation events — repeatedly queuing
  // the same target floods the timeline. Skip if the change is below
  // perceptual threshold for this param's range.
  const last = lastWriteCache.get(param)
  if (last != null && Math.abs(last - target) < 1e-4) return
  lastWriteCache.set(param, target)
  const now = ctx.currentTime
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now)
  else param.cancelScheduledValues(now)
  param.linearRampToValueAtTime(target, now + horizon)
}

/**
 * Sample a baked Speaker volume envelope at the given clock time, with
 * linear interpolation between adjacent samples and modulo wrap so the
 * envelope loops cleanly. Defaults to 1.0 (silent transparent) for empty
 * or malformed envelopes.
 */
function sampleEnvelope(env: { fps: number; samples: number[] }, t: number): number {
  const n = env.samples.length
  if (n === 0 || env.fps <= 0) return 1
  if (n === 1) return env.samples[0]
  const len = n / env.fps
  const tMod = ((t % len) + len) % len
  const idx = tMod * env.fps
  const i0 = Math.floor(idx) % n
  const i1 = (i0 + 1) % n
  const frac = idx - Math.floor(idx)
  const v = env.samples[i0] * (1 - frac) + env.samples[i1] * frac
  return Number.isFinite(v) ? v : 1
}

// Promote legacy `vol`/`modulator` shorthand to params.vol AND expand the
// `radius` shorthand into refDist/maxDist/rolloff so the rest of the bus
// only has to handle one shape. Idempotent.
function normalizeLoopDef(def: LoopDef): LoopDef {
  const params: Record<string, ParamSpec> = { ...(def.params ?? {}) }
  if (params.vol == null && def.vol != null) {
    params.vol = { base: def.vol, modulator: def.modulator }
  }
  let { refDist, maxDist, rolloff } = def
  if (def.radius != null) {
    refDist = refDist ?? 0
    maxDist = maxDist ?? def.radius
    rolloff = rolloff ?? 1
  }
  return { ...def, params, refDist, maxDist, rolloff }
}

interface LoopRuntime {
  def: LoopDef
  // Sample-backed loops use a THREE.Audio / PositionalAudio (whose internal
  // gain we set via setVolume each tick).
  node: THREE.Audio | THREE.PositionalAudio | null
  // Synth-backed loops bypass three.js entirely and own a raw GainNode that
  // the bus modulates per frame.
  synth: SynthLoopHandle | null
  synthGain: GainNode | null
  // Sample-backed loops can carry BiquadFilters (lowpass/highpass/bandpass)
  // inserted between source and listener via THREE.Audio.setFilters(). Maps
  // filter type → BiquadFilterNode so applyParams can find them by name.
  filters: Record<string, BiquadFilterNode> | null
  pendingAnchor: string | null  // anchor id we're waiting on (sample loops)
  buffer: AudioBuffer | null
  // Last computed gain (post-modulator, post-override, post-master). Read
  // by the visualiser to draw a live level meter at each anchor.
  lastGain: number
}

// Build the BiquadFilters declared by a loop's params. Keys are the filter
// type — a registry param named `lowpass` / `highpass` / `bandpass` becomes
// the matching BiquadFilter, returned in a stable order so setFilters()
// receives a deterministic chain (highpass → bandpass → lowpass = "trim
// bottom, focus middle, trim top" in that order).
const FILTER_NAMES = ['highpass', 'bandpass', 'lowpass'] as const
/**
 * Sample a cubic Bézier at t (0..1). Returns [x, y]. The kernel uses
 * Bernstein form so all four control points contribute smoothly:
 *   B(t) = (1-t)³·p1 + 3(1-t)²·t·cp1 + 3(1-t)·t²·cp2 + t³·p2
 */
function sampleCubicBezier(
  p1: [number, number], cp1: [number, number],
  cp2: [number, number], p2: [number, number],
  t: number,
): [number, number] {
  const u = 1 - t
  const u2 = u * u, u3 = u2 * u
  const t2 = t * t, t3 = t2 * t
  const x = u3 * p1[0] + 3 * u2 * t * cp1[0] + 3 * u * t2 * cp2[0] + t3 * p2[0]
  const y = u3 * p1[1] + 3 * u2 * t * cp1[1] + 3 * u * t2 * cp2[1] + t3 * p2[1]
  return [x, y]
}

/**
 * Build a single-channel AudioBuffer from a KernelSpec (#65). Samples
 * the curve at `taps` evenly-spaced t values, applies exp(-decay·t),
 * scales by `wet`, normalises so peak = wet (so different decay rates
 * produce comparable loudness). Curve y values can exceed [0..1] when
 * control handles drive the spline outside the visible canvas — that's
 * fine, sampleCubicBezier returns whatever the polynomial yields.
 */
function buildKernelBuffer(ctx: AudioContext, spec: KernelSpec): AudioBuffer {
  const taps = Math.max(2, Math.min(1024, Math.floor(spec.taps)))
  const buf = ctx.createBuffer(1, taps, ctx.sampleRate)
  const data = buf.getChannelData(0)
  // First pass: raw sampled curve × decay envelope.
  let peak = 0
  for (let i = 0; i < taps; i++) {
    const t = i / (taps - 1)
    const [, y] = sampleCubicBezier(spec.p1, spec.cp1, spec.cp2, spec.p2, t)
    const env = spec.decay > 0 ? Math.exp(-spec.decay * t) : 1
    const v = y * env
    data[i] = v
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  // Normalise so the louder shape doesn't blow out vs. a quieter one.
  // Then scale by wet — caller's "kernel intensity" knob.
  if (peak > 1e-6) {
    const scale = spec.wet / peak
    for (let i = 0; i < taps; i++) data[i] *= scale
  }
  return buf
}

function buildFiltersForParams(ctx: AudioContext, params: Record<string, ParamSpec> | undefined): { nodes: BiquadFilterNode[]; map: Record<string, BiquadFilterNode> } {
  const map: Record<string, BiquadFilterNode> = {}
  const nodes: BiquadFilterNode[] = []
  if (!params) return { nodes, map }
  for (const name of FILTER_NAMES) {
    if (!params[name]) continue
    const f = ctx.createBiquadFilter()
    f.type = name as BiquadFilterType
    // Sensible defaults so the filter is transparent until applyParams writes
    // a real value (avoids a brief silence on attach if mod is mid-range).
    f.frequency.value = name === 'lowpass' ? 22000 : name === 'highpass' ? 20 : 1000
    f.Q.value = 0.7
    map[name] = f
    nodes.push(f)
  }
  return { nodes, map }
}

class AudioBus {
  listener: THREE.AudioListener | null = null
  private anchors = new Map<string, THREE.Object3D>()
  private modulators = new Map<string, Modulator>()
  private loops = new Map<string, LoopRuntime>()
  // Sample loader cache. Each src string maps to a single in-flight Promise
  // so multiple anchors / event uses of the same buffer share one fetch.
  private bufferCache = new Map<string, Promise<AudioBuffer>>()
  private audioLoader = new THREE.AudioLoader()
  // Gain graph for synth events: ambientGain | sfxGain → masterGain → ctx.destination.
  // Loops use THREE.Audio's built-in gain (their volumes are recomputed in tick()).
  private masterGain: GainNode | null = null
  private ambientGain: GainNode | null = null
  private sfxGain: GainNode | null = null
  // Categorise loops by key prefix for now: ambient_* and wind_* → ambient,
  // everything else (synth events + spatial loops) → sfx.
  private masterMute = false
  private masterVol = 1.0
  private categoryVol: Record<Category, number> = { master: 1, ambient: 1, sfx: 1 }
  private categoryMute: Record<Category, boolean> = { master: false, ambient: false, sfx: false }
  // Camera-movement intensity 0..1. Composite metric: orbit angular speed
  // when in orbit mode, linear camera velocity when in walk mode. Drives
  // the wind_cutting layer either way ("you're moving fast → air rushes").
  // Name kept as cameraOrbitSpeed for registry compat.
  private cameraOrbitSpeed = 0
  private windStrengthGetter: (() => number) | null = null

  // Per-sound user overrides driven by the Audio panel. vol/speed are
  // multipliers on top of the registry base; mute forces 0; radius (meters)
  // overrides the registry's `radius`/`maxDist` directly so user can drag
  // the reach in real time.
  private loopOverrides = new Map<string, { vol?: number; speed?: number; mute?: boolean; radius?: number }>()
  private eventOverrides = new Map<string, { vol?: number; speed?: number; mute?: boolean }>()
  // Active BufferSourceNodes per event key. Pushed on play(), removed on
  // 'ended'. Polyphony cap enforced by stopping voices[0] (oldest first).
  private activeEventSources = new Map<string, AudioBufferSourceNode[]>()
  // Slice-rotation rumble: target (0|1) is set by subscriptions.ts when
  // drag||anim transitions; tick() smooths the actual value with separate
  // attack/release rates so the rumble fades in/out rather than snapping.
  private sliceRotActiveTarget = 0
  private sliceRotActive = 0
  // Theme music duck multiplier — 1.0 in orbit, 0.5 in walk so the theme
  // recedes when the player is "in the world" rather than observing it.
  private themeWalkDuck = 1.0
  // Pond proximity 0..1; 1 means listener is inside the pond's audible
  // refDist. Used by `awayFromPond` modulator to cross-fade ambient wind
  // away when the water sound takes over.
  private pondProximity = 0
  // Grass-swipe intensity 0..1; cursor-on-grass × cursor speed, written
  // by the TileGrid hover-stamp loop.
  private grassSwipeIntensity = 0
  // Car speed 0..1 — frame-to-frame world velocity of the 'car' anchor
  // normalised to the car loop's nominal CAR_SPEED. Drives the engine's
  // oscFreq + lowpass via param bindings.
  private carSpeed = 0

  // Sphere-projection plumbing. Diorama anchors (car/windmill/pond/birds_flock)
  // live in dScene's flat 4×6 cube-net coord space; the GPU folds it onto the
  // sphere at render time. The audio listener is in main-scene world space
  // (orbiting at sphere radius). To put PositionalAudio at the same point the
  // user *sees*, we project each diorama source flat→sphere on the CPU each
  // frame and write the result to a tracker Object3D in main scene. The
  // PositionalAudio attaches to the tracker, not the source.
  private dioramaSources = new Map<string, THREE.Object3D>()
  private dioramaTrackers = new Map<string, THREE.Object3D>()
  private trackerScene: THREE.Scene | null = null
  private dioramaRoot: THREE.Object3D | null = null
  private _trackerScratchFlat = new THREE.Vector3()
  private _trackerScratchSphere = new THREE.Vector3()
  private _savedRootPos = new THREE.Vector3()
  private _savedRootQuat = new THREE.Quaternion()

  attachListener(camera: THREE.Camera) {
    if (this.listener && this.listener.parent === camera) return
    if (this.listener) this.listener.parent?.remove(this.listener)
    this.listener = new THREE.AudioListener()
    camera.add(this.listener)
    // Build the gain graph once we have a context.
    const ctx = this.listener.context
    this.masterGain = ctx.createGain()
    this.ambientGain = ctx.createGain()
    this.sfxGain = ctx.createGain()
    this.ambientGain.connect(this.masterGain)
    this.sfxGain.connect(this.masterGain)
    this.masterGain.connect(ctx.destination)
    this.applyGraphGains()
    // Boot all loops once the graph exists.
    this.bootLoops()
  }

  detachListener() {
    if (!this.listener) return
    this.listener.parent?.remove(this.listener)
    this.listener = null
  }

  registerAnchor(id: string, obj: THREE.Object3D) {
    this.anchors.set(id, obj)
    // Resolve any loops waiting on this anchor.
    for (const lr of this.loops.values()) {
      if (lr.pendingAnchor === id) this.attachLoop(lr)
    }
  }

  // Register a group's center-of-mass (Box3 centre) as the audio anchor.
  // Drops a child Object3D at the centre and registers THAT — so
  // PositionalAudio + the visualiser sphere both attach at the visual
  // middle of the group instead of its local-space (0,0,0) origin.
  // Idempotent — re-registering reuses the existing centre child.
  //
  // The COM child lives in dScene (flat cube-net space). When sphere
  // projection is wired (`attachSphereScene` + `setDioramaRoot` both called),
  // we register a tracker Object3D in main scene as the actual audio anchor
  // and treat the COM child as the source for per-frame projection.
  registerAnchorAtCenter(id: string, group: THREE.Object3D) {
    const childName = `__audio_origin_${id}`
    let origin = group.getObjectByName(childName) as THREE.Object3D | undefined
    if (!origin) {
      // Force matrices fresh so Box3 reads accurate world bounds, then
      // convert the world centre back into the group's local frame so
      // the child holds steady when the group's own transform animates
      // (the car driving around the equator, for example).
      group.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(group)
      const center = new THREE.Vector3()
      box.getCenter(center)
      group.worldToLocal(center)
      origin = new THREE.Object3D()
      origin.name = childName
      origin.position.copy(center)
      group.add(origin)
    }
    this.registerDioramaSource(id, origin)
  }

  // Like registerAnchorAtCenter but the caller supplies a pre-built source
  // Object3D living in dScene (used for dynamic sources like the birds-flock
  // centroid where COM doesn't apply — the source's local position is
  // updated each frame by the producer).
  registerDioramaSource(id: string, source: THREE.Object3D) {
    this.dioramaSources.set(id, source)
    if (this.trackerScene) {
      const tracker = this.ensureTracker(id)
      this.registerAnchor(id, tracker)
    } else {
      // Sphere projection not wired (preview modes, tests). Fall back to
      // attaching audio directly to the source — wrong-coord-space, but
      // matches old behaviour.
      this.registerAnchor(id, source)
    }
  }

  private ensureTracker(id: string): THREE.Object3D {
    let tracker = this.dioramaTrackers.get(id)
    if (!tracker) {
      tracker = new THREE.Object3D()
      tracker.name = `__audio_sphere_tracker_${id}`
      this.dioramaTrackers.set(id, tracker)
    }
    if (this.trackerScene && tracker.parent !== this.trackerScene) {
      tracker.parent?.remove(tracker)
      this.trackerScene.add(tracker)
    }
    return tracker
  }

  // Wire the main R3F scene used to host trackers. Called once by AudioBus.tsx.
  attachSphereScene(scene: THREE.Scene) {
    if (this.trackerScene === scene) return
    this.trackerScene = scene
    // Retroactively migrate already-registered diorama sources to trackers.
    // Reparents any PositionalAudio nodes already attached under the source —
    // without this, registerAnchor only updates the lookup map, leaving live
    // audio nodes stranded under the dScene COM (= chop never gets fixed).
    for (const [id, source] of this.dioramaSources) {
      const tracker = this.ensureTracker(id)
      if (this.anchors.get(id) === source) {
        this.anchors.set(id, tracker)
      }
      for (const lr of this.loops.values()) {
        if (lr.def.anchor !== `object:${id}` || !lr.node) continue
        if (lr.node.parent === tracker) continue
        lr.node.parent?.remove(lr.node)
        tracker.add(lr.node)
      }
    }
  }

  // Wire the diorama root for the temp-reset trick during projection. Called
  // by TileGrid each time it builds (or hot-replaces) the diorama.
  setDioramaRoot(root: THREE.Object3D | null) {
    this.dioramaRoot = root
  }

  // Per-frame: project every diorama source from cube-net flat space onto the
  // sphere surface and write the result to its tracker. Resets diorama.root
  // to identity around the read so source.getWorldPosition() returns
  // dScene-local coords (TileGrid leaves the root at the last-tile transform
  // after rendering — reading without resetting yields garbage).
  updateSphereTrackers() {
    const root = this.dioramaRoot
    if (!root || !this.trackerScene || this.dioramaSources.size === 0) return

    this._savedRootPos.copy(root.position)
    this._savedRootQuat.copy(root.quaternion)
    root.position.set(0, 0, 0)
    root.quaternion.identity()
    root.updateMatrix()
    root.updateMatrixWorld(true)

    for (const [id, source] of this.dioramaSources) {
      const tracker = this.dioramaTrackers.get(id)
      if (!tracker) continue
      source.getWorldPosition(this._trackerScratchFlat)
      if (cubeNetToSphere(this._trackerScratchFlat, this._trackerScratchSphere)) {
        tracker.position.copy(this._trackerScratchSphere)
      }
    }

    root.position.copy(this._savedRootPos)
    root.quaternion.copy(this._savedRootQuat)
    root.updateMatrix()
    root.updateMatrixWorld(true)
  }

  unregisterAnchor(id: string) {
    this.anchors.delete(id)
    this.dioramaSources.delete(id)
    const tracker = this.dioramaTrackers.get(id)
    if (tracker) {
      tracker.parent?.remove(tracker)
      this.dioramaTrackers.delete(id)
    }
    // Stop and detach loops bound to this anchor; mark them pending.
    for (const lr of this.loops.values()) {
      if (lr.def.anchor === `object:${id}` && lr.node) {
        try { lr.node.stop() } catch { /* ignore */ }
        lr.node.parent?.remove(lr.node)
        lr.node = null
        lr.pendingAnchor = id
      }
    }
  }

  setModulator(name: string, fn: Modulator) {
    this.modulators.set(name, fn)
  }

  /** Names of every registered modulator. Used by the audio editor's
   *  param dropdown to populate "what can I bind this param to?" */
  listModulatorNames(): string[] {
    return Array.from(this.modulators.keys()).sort()
  }

  /** Live-edit a param spec on a loop. Bypasses registerLoop's teardown
   *  (no node-detach, no buffer reload) — applyParams picks up the new
   *  spec on its next tick, so dragging base/min/max in the editor
   *  produces a smooth audible sweep without pops.
   *
   *  Mutates BOTH the runtime def (what applyParams reads) AND the
   *  audioLive entry (what the Commit button bakes into audio.json),
   *  so the two never drift mid-session.
   */
  setLoopParamSpec(key: string, name: string, spec: ParamSpec) {
    const lr = this.loops.get(key)
    if (lr) {
      lr.def.params = { ...(lr.def.params ?? {}), [name]: { ...spec } }
    }
    // audioLive is the editor's commit source; keep it in sync. Search
    // both static loops + runtimeLoops so glb-imported KHR_audio_emitter
    // entries also accept edits.
    const live = audioLive.loops.find(l => l.key === key)
    if (live) {
      live.params = { ...(live.params ?? {}), [name]: { ...spec } }
    } else {
      const rt = this.runtimeLoops.get(key)
      if (rt) rt.params = { ...(rt.params ?? {}), [name]: { ...spec } }
    }
  }

  /** Read the current runtime def for a loop. Editor uses this to
   *  populate sliders with what applyParams is actually using right
   *  now (post any setLoopParamSpec edits). */
  getLoopRuntimeDef(key: string): LoopDef | undefined {
    return this.loops.get(key)?.def
  }

  /** Set the kernel filter (#65) on a loop. Mutates audioLive (commit
   *  source) AND triggers a reattach via registerLoop so the convolver
   *  joins the filter chain. Brief audio glitch on swap is acceptable
   *  for an authoring tool — perfect-smooth update would require
   *  bypassing THREE.Audio's setFilters routing. Pass `undefined` to
   *  remove the kernel. */
  setLoopKernel(key: string, kernel: KernelSpec | undefined) {
    const live = audioLive.loops.find(l => l.key === key)
    if (live) {
      if (kernel) live.kernel = kernel
      else delete live.kernel
      // Re-attach so the new convolver lands in setFilters.
      this.registerLoop(live)
    }
  }

  /** Set the kernel filter on an event. No re-attach needed — play()
   *  reads def.kernel each call, so the next trigger uses the new
   *  spec. */
  setEventKernel(key: string, kernel: KernelSpec | undefined) {
    const live = audioLive.events.find(e => e.key === key)
    if (live) {
      if (kernel) live.kernel = kernel
      else delete live.kernel
    }
  }

  setWindStrengthSource(fn: () => number) {
    this.windStrengthGetter = fn
  }

  setCameraOrbitSpeed(v: number) {
    this.cameraOrbitSpeed = Math.max(0, Math.min(1, v))
  }

  setSliceRotationActive(target: 0 | 1) {
    this.sliceRotActiveTarget = target
  }

  setThemeWalkDuck(v: number) {
    this.themeWalkDuck = Math.max(0, Math.min(1, v))
  }

  setPondProximity(v: number) {
    this.pondProximity = Math.max(0, Math.min(1, v))
  }

  setGrassSwipeIntensity(v: number) {
    this.grassSwipeIntensity = Math.max(0, Math.min(1, v))
  }

  setCarSpeed(v: number) {
    this.carSpeed = Math.max(0, Math.min(1, v))
  }

  // ── Per-sound overrides ─────────────────────────────────────────────
  setLoopOverride(key: string, override: { vol?: number; speed?: number; mute?: boolean; radius?: number }) {
    const prev = this.loopOverrides.get(key) ?? {}
    const next = { ...prev, ...override }
    this.loopOverrides.set(key, next)
    // Push speed + radius to the live source NOW. Speed: setPlaybackRate
    // (sample loops only). Radius: setMaxDistance on PositionalAudio so the
    // reach edge moves immediately as the slider drags.
    const lr = this.loops.get(key)
    if (lr?.node && next.speed != null) {
      try { lr.node.setPlaybackRate(next.speed) } catch { /* ignore */ }
    }
    if (next.radius != null && lr?.node && lr.node instanceof THREE.PositionalAudio) {
      try { lr.node.setMaxDistance(next.radius) } catch { /* ignore */ }
    }
  }
  setEventOverride(key: string, override: { vol?: number; speed?: number; mute?: boolean }) {
    const prev = this.eventOverrides.get(key) ?? {}
    this.eventOverrides.set(key, { ...prev, ...override })
  }
  getLoopOverride(key: string) { return this.loopOverrides.get(key) }
  getEventOverride(key: string) { return this.eventOverrides.get(key) }
  // For the visualiser — return the gain we last computed for this loop.
  getLastLoopGain(key: string): number {
    const lr = this.loops.get(key)
    return lr?.lastGain ?? 0
  }

  // Effective reach radius — override wins, then registry radius/maxDist,
  // else 0 (non-positional). ReachSphere reads this so the wireframe
  // tracks the panel slider.
  getEffectiveRadius(key: string): number {
    const ovr = this.loopOverrides.get(key)
    if (ovr?.radius != null) return ovr.radius
    const lr = this.loops.get(key)
    return lr?.def.radius ?? lr?.def.maxDist ?? 0
  }

  // Diagnostic: dump every active loop's runtime state. Used from devtools
  // to find sounds escaping the mute path.
  dumpLoops(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      masterMute: this.masterMute, masterVol: this.masterVol,
      categoryMute: this.categoryMute, categoryVol: this.categoryVol,
      masterGainValue: this.masterGain?.gain.value,
      ambientGainValue: this.ambientGain?.gain.value,
      sfxGainValue: this.sfxGain?.gain.value,
    }
    const loops: Record<string, unknown> = {}
    for (const [k, lr] of this.loops) {
      const live = lr.node ? (lr.node as THREE.Audio).getVolume?.() : null
      loops[k] = {
        nodeKind: lr.node ? (lr.node instanceof THREE.PositionalAudio ? 'positional' : 'audio') : null,
        synth: !!lr.synth,
        synthGainValue: lr.synthGain?.gain.value,
        liveVolume: live,
        lastGain: lr.lastGain,
        override: this.loopOverrides.get(k),
      }
    }
    out.loops = loops
    return out
  }

  setMasterMute(m: boolean) { this.masterMute = m; this.applyGraphGains(); this.applyAllVolumes() }
  setMasterVolume(v: number) { this.masterVol = v; this.applyGraphGains(); this.applyAllVolumes() }
  setCategoryVolume(c: Category, v: number) { this.categoryVol[c] = v; this.applyGraphGains(); this.applyAllVolumes() }
  setCategoryMute(c: Category, m: boolean) { this.categoryMute[c] = m; this.applyGraphGains(); this.applyAllVolumes() }

  // Trigger an event from registry by key. Supports synth: voices and
  // sample events (audio/<file>.ogg) routed through sfxGain. Sample events
  // load + cache the buffer on first call; subsequent plays reuse it.
  play(key: string, _opts?: { volume?: number }) {
    const def = REGISTRY.events.find(e => e.key === key)
    if (!def) return
    const ovr = this.eventOverrides.get(key)
    if (ovr?.mute) return
    // Publish to the audio editor's left-panel selector. Fires before the
    // mute-gate would also publish silenced triggers — but mute is editor-
    // owned, and a silenced trigger still represents an interaction the
    // user wants to see. Net: publish unconditionally on a known def.
    useLastTriggered.getState().publish(key)
    const ctx = this.listener?.context
    if (!ctx || !this.sfxGain) return
    // Resume the context if the browser auto-suspended it (autoplay policy).
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ })

    const speedMul = ovr?.speed ?? 1
    const volMul = ovr?.vol ?? 1

    if (def.src.startsWith('synth:')) {
      const fn = SYNTHS[def.src.slice('synth:'.length)]
      if (!fn) return
      // Synth voices don't expose a speed knob — pass an inline gain node
      // when vol override needs to attenuate.
      if (volMul !== 1) {
        const eventGain = ctx.createGain()
        eventGain.gain.value = volMul
        eventGain.connect(this.sfxGain)
        fn(ctx, eventGain)
      } else {
        fn(ctx, this.sfxGain)
      }
      return
    }

    // Sample event — resolve the cached buffer, then schedule a fresh
    // AudioBufferSourceNode through sfxGain. Pitch jitter randomises
    // playbackRate to avoid the cloned-sample sound on repeated triggers
    // (most useful for footsteps); user-set speed override multiplies on top.
    void this.loadBuffer(def.src).then(buf => {
      if (!this.sfxGain) return
      // Polyphony gate — if at the cap, stop the oldest active voice
      // BEFORE adding the new one. Stopping triggers the 'ended' handler
      // below which prunes the list, but we explicitly shift here too so
      // the slot is free synchronously.
      if (def.polyphony != null && def.polyphony >= 1) {
        const list = this.activeEventSources.get(key) ?? []
        while (list.length >= def.polyphony) {
          const old = list.shift()
          if (old) { try { old.stop() } catch { /* ignore — already ended */ } }
        }
        this.activeEventSources.set(key, list)
      }
      const src = ctx.createBufferSource()
      src.buffer = buf
      let rate = speedMul
      if (def.pitchJitter && def.pitchJitter > 0) {
        const j = def.pitchJitter
        rate *= 1 - j + Math.random() * (2 * j)
      }
      src.playbackRate.value = rate
      // Volume gain (event override × def). dst is what `src` actually
      // connects to — either the volMul gain or sfxGain directly.
      const dst: AudioNode = volMul !== 1
        ? (() => { const g = ctx.createGain(); g.gain.value = volMul; g.connect(this.sfxGain!); return g })()
        : this.sfxGain
      // Kernel filter (#65) — convolve the source through a user-drawn
      // impulse response. Per-play graph for events:
      //
      //   BufferSource → split:
      //                    dry GainNode (gain = 1 - wet) ─→ dst
      //                    ConvolverNode → wet GainNode (gain = 1) ─→ dst
      //
      // wet=0 → pure dry (convolver branch contributes nothing). wet=1
      // → fully convolved + zero dry. The convolver's output gain is
      // baked into the kernel buffer (peak normalised to wet), so the
      // wet branch's GainNode stays at 1 and the dry branch's gain
      // moves with (1 - wet). Net mix is constant-ish at unity.
      if (def.kernel && def.kernel.wet > 0) {
        const conv = ctx.createConvolver()
        conv.buffer = buildKernelBuffer(ctx, def.kernel)
        const dry = ctx.createGain()
        dry.gain.value = Math.max(0, 1 - def.kernel.wet)
        const wet = ctx.createGain()
        wet.gain.value = 1
        src.connect(dry); dry.connect(dst)
        src.connect(conv); conv.connect(wet); wet.connect(dst)
      } else {
        src.connect(dst)
      }
      // Track + auto-remove. 'ended' fires on natural finish AND on
      // explicit .stop() — same handler covers both paths.
      const list = this.activeEventSources.get(key) ?? []
      list.push(src)
      this.activeEventSources.set(key, list)
      src.addEventListener('ended', () => {
        const cur = this.activeEventSources.get(key)
        if (!cur) return
        const idx = cur.indexOf(src)
        if (idx >= 0) cur.splice(idx, 1)
      })
      src.start()
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[audio] failed to load event sample', def.src, err)
    })
  }

  /** Public wrapper around loadBuffer — the audio editor needs the
   *  decoded AudioBuffer to compute waveform peaks (#52). Reuses the
   *  buffer cache, so calling this from the editor doesn't re-decode
   *  samples that are already loaded for runtime playback. */
  loadSampleBuffer(src: string): Promise<AudioBuffer> {
    return this.loadBuffer(src)
  }

  private loadBuffer(src: string): Promise<AudioBuffer> {
    // Registry entries are public/-relative ("audio/foo.ogg"). Without a
    // leading slash, fetch resolves them against document.baseURI — fine on
    // /, broken on /optimize/ where they'd hit /optimize/audio/foo.ogg →
    // SPA fallback HTML → decodeAudioData EncodingError.
    const url = src.startsWith('/') ? src : '/' + src
    const cached = this.bufferCache.get(url)
    if (cached) return cached
    const promise = new Promise<AudioBuffer>((resolve, reject) => {
      this.audioLoader.load(url, resolve, undefined, reject)
    })
    this.bufferCache.set(url, promise)
    return promise
  }

  // Internal — called by a per-frame tick. AudioBus passes dt so we can
  // smooth state-driven modulators (slice rotation, future similar).
  tick(dt: number = 1 / 60) {
    if (!this.listener) return
    // Smooth slice-rumble: 60ms attack so even a quick 250ms commit anim
    // brings the loop up to ~80% of base before it ends, 350ms release so
    // it tails off rather than cutting hard.
    {
      const target = this.sliceRotActiveTarget
      const cur = this.sliceRotActive
      const tau = target > cur ? 0.06 : 0.35
      const k = Math.min(1, dt / tau)
      this.sliceRotActive = cur + (target - cur) * k
    }
    // Update loop volumes from modulators. AudioParam.value rejects non-
    // finite — guard at the assignment site so an early-frame race that
    // produces NaN/Infinity (e.g. modulator reading an uninitialised
    // uniform) doesn't throw.
    for (const lr of this.loops.values()) {
      this.applyParams(lr)
    }
  }

  // Compute and write every param binding for one loop.
  //   `vol`  → master/category-aware setVolume / synthGain.gain
  //   `rate` → setPlaybackRate (samples) AND/OR handle.params.rate.value (synth)
  //   any other → handle.params[name].value (synth-exposed AudioParams only)
  private applyParams(lr: LoopRuntime) {
    if (!this.listener) return
    const ctx = this.listener.context
    const ovr = this.loopOverrides.get(lr.def.key)
    const muted = ovr?.mute === true
    const params = lr.def.params ?? {}

    for (const [name, spec] of Object.entries(params)) {
      const mod = this.combinedModulator(spec.modulator)
      let value: number
      if (spec.min != null && spec.max != null) {
        const t = spec.invert ? (1 - mod) : mod
        value = spec.min + t * (spec.max - spec.min)
      } else {
        value = (spec.base ?? 1) * mod
      }

      if (name === 'vol') {
        const userVol = ovr?.vol ?? 1
        // WYSIWYG envelope: a Speaker.volume keyframe curve baked in
        // Blender. Loops independently against AudioContext currentTime
        // (no visual-mixer sync — the envelope length is the authored
        // loop length).
        const env = lr.def.envelope
        const envMul = env ? sampleEnvelope(env, ctx.currentTime) : 1
        const raw = muted ? 0 : this.computeFinalGain(lr.def.key, value * userVol * envMul, 1)
        const finalGain = Number.isFinite(raw) ? raw : 0
        lr.lastGain = finalGain
        // Bypass THREE.Audio.setVolume / direct .value writes — those step
        // sample-discontinuously and zipper at frame boundaries. Smooth via
        // the underlying gain AudioParam.
        if (lr.node) smoothSet(lr.node.gain.gain, finalGain, ctx)
        if (lr.synthGain) smoothSet(lr.synthGain.gain, finalGain, ctx)
        continue
      }

      if (!Number.isFinite(value)) continue
      if (name === 'rate') {
        const speedMul = ovr?.speed ?? 1
        const r = value * speedMul
        // For samples: ramp the BufferSource's playbackRate AudioParam.
        // For synth-backed nodes, lr.node.source isn't a BufferSource
        // (setNodeSource path) — try/catch absorbs it.
        try {
          const src = (lr.node as unknown as { source?: { playbackRate?: AudioParam } } | null)?.source
          if (src?.playbackRate) smoothSet(src.playbackRate, r, ctx, SMOOTH_HORIZON_RATE)
        } catch { /* ignore */ }
        const ap = lr.synth?.params?.rate
        if (ap) smoothSet(ap, r, ctx, SMOOTH_HORIZON_RATE)
        continue
      }

      // Filter params (lowpass / highpass / bandpass) — smooth-sweep the
      // sample-loop's BiquadFilter, OR a synth-exposed AudioParam. Q
      // updates apply on the same tick — bus reads spec.q each frame so
      // the editor's slider is heard immediately, with the same smoothSet
      // ramp as frequency to avoid zipper noise on rapid drags.
      const filt = lr.filters?.[name]
      if (filt) {
        smoothSet(filt.frequency, value, ctx, SMOOTH_HORIZON_FILT)
        if (spec.q != null) smoothSet(filt.Q, spec.q, ctx, SMOOTH_HORIZON_FILT)
        continue
      }
      const ap = lr.synth?.params?.[name]
      if (ap) smoothSet(ap, value, ctx, SMOOTH_HORIZON_FILT)
    }
  }

  private combinedModulator(spec: string | string[] | undefined): number {
    if (!spec) return 1
    if (typeof spec === 'string') return this.modulatorValue(spec)
    let acc = 1
    for (const name of spec) acc *= this.modulatorValue(name)
    return acc
  }

  private modulatorValue(name: string): number {
    if (name === 'windStrength' && this.windStrengthGetter) {
      // Wind uniform ranges 0..4 in Leva; map to 0..1 with a soft knee.
      const ws = this.windStrengthGetter()
      const v = Math.min(1, ws / 2.0)
      return Number.isFinite(v) ? v : 0
    }
    if (name === 'cameraOrbitSpeed') return Number.isFinite(this.cameraOrbitSpeed) ? this.cameraOrbitSpeed : 0
    if (name === 'sliceRotationActive') return Number.isFinite(this.sliceRotActive) ? this.sliceRotActive : 0
    if (name === 'themeWalkDuck') return Number.isFinite(this.themeWalkDuck) ? this.themeWalkDuck : 1
    if (name === 'awayFromPond') return 1 - 0.7 * (Number.isFinite(this.pondProximity) ? this.pondProximity : 0)
    if (name === 'grassSwipeIntensity') return Number.isFinite(this.grassSwipeIntensity) ? this.grassSwipeIntensity : 0
    if (name === 'carSpeed') return Number.isFinite(this.carSpeed) ? this.carSpeed : 0
    const fn = this.modulators.get(name)
    return fn ? fn() : 1
  }

  private categoryFor(key: string): Category {
    if (key.startsWith('ambient_') || key === 'wind_cutting') return 'ambient'
    return 'sfx'
  }

  private computeFinalGain(key: string, base: number, mod: number): number {
    const cat = this.categoryFor(key)
    if (this.masterMute || this.categoryMute.master) return 0
    if (this.categoryMute[cat]) return 0
    return base * mod * this.masterVol * this.categoryVol.master * this.categoryVol[cat]
  }

  private applyGraphGains() {
    if (!this.masterGain || !this.ambientGain || !this.sfxGain || !this.listener) return
    const ctx = this.listener.context
    const masterEffective = (this.masterMute || this.categoryMute.master) ? 0 : this.masterVol * this.categoryVol.master
    const ambientEffective = this.categoryMute.ambient ? 0 : this.categoryVol.ambient
    const sfxEffective = this.categoryMute.sfx ? 0 : this.categoryVol.sfx
    smoothSet(this.masterGain.gain,  masterEffective,  ctx)
    smoothSet(this.ambientGain.gain, ambientEffective, ctx)
    smoothSet(this.sfxGain.gain,     sfxEffective,     ctx)
    // Belt-and-suspenders: slave THREE.AudioListener's own master gain to
    // master mute too. THREE.Audio / PositionalAudio bypass our masterGain
    // graph (they route through the listener directly), so without this
    // any source whose per-node setVolume() is briefly stale would still
    // be audible.
    smoothSet(this.listener.gain.gain, masterEffective, ctx)
  }

  private applyAllVolumes() {
    for (const lr of this.loops.values()) this.applyParams(lr)
  }

  // Loop bookkeeping. Idempotent — boot creates one runtime per definition.
  registerLoopRuntime(def: LoopDef): LoopRuntime {
    const existing = this.loops.get(def.key)
    if (existing) return existing
    const lr: LoopRuntime = { def: normalizeLoopDef(def), node: null, synth: null, synthGain: null, filters: null, pendingAnchor: null, buffer: null, lastGain: 0 }
    this.loops.set(def.key, lr)
    return lr
  }

  getAnchor(id: string): THREE.Object3D | undefined {
    return this.anchors.get(id)
  }

  // Runtime loop registry — entries added at runtime (e.g. from a glb's
  // KHR_audio_emitter import) live here, separate from the static REGISTRY.
  // Visualizer + any UI that wants the full picture should use getAllLoopDefs.
  private runtimeLoops = new Map<string, LoopDef>()

  /**
   * Add a loop at runtime. Idempotent on key — re-registering with the same
   * key replaces the prior runtime def. If the loop is already attached, the
   * existing audio node is torn down and rebuilt with the new def. Used by
   * the KHR_audio_emitter importer (glb-driven audio) and Live-Mode swaps.
   */
  registerLoop(def: LoopDef) {
    const normalized = normalizeLoopDef(def)
    const existing = this.loops.get(def.key)
    if (existing) {
      // Tear down existing node so the new def takes effect (radius / src /
      // params may have changed).
      this.detachLoopNode(existing)
      existing.def = normalized
    } else {
      this.runtimeLoops.set(def.key, normalized)
      this.registerLoopRuntime(normalized)
    }
    // Bus may be pre-listener (boot deferred) — attachLoop short-circuits
    // until the listener is available.
    const lr = this.loops.get(def.key)
    if (lr && this.listener) this.attachLoop(lr)
  }

  /**
   * Remove a runtime loop. Fades the audio node down briefly to avoid pops,
   * then detaches and stops it. No-op if the key isn't a runtime loop (we
   * don't allow yanking REGISTRY entries — those are static).
   */
  unregisterLoop(key: string) {
    if (!this.runtimeLoops.has(key)) return
    const lr = this.loops.get(key)
    if (lr) {
      this.detachLoopNode(lr)
      this.loops.delete(key)
    }
    this.runtimeLoops.delete(key)
  }

  /** REGISTRY.loops + runtimeLoops, in registration order. */
  getAllLoopDefs(): LoopDef[] {
    return [...REGISTRY.loops, ...this.runtimeLoops.values()]
  }

  /**
   * Tear down an attached loop's audio node + filters. Source nodes can't
   * be restarted once stopped, so the runtime entry's `node`/`synth` slots
   * are nulled — attachLoop rebuilds from `def` on next call.
   */
  private detachLoopNode(lr: LoopRuntime) {
    const ctx = this.listener?.context ?? null
    if (lr.node) {
      // Brief fade to avoid pops on swap.
      try {
        if (ctx) {
          const g = lr.node.gain.gain
          smoothSet(g, 0, ctx, 0.05)
        }
      } catch { /* ignore */ }
      try { lr.node.stop() } catch { /* ignore */ }
      lr.node.parent?.remove(lr.node)
      lr.node = null
    }
    if (lr.synth) {
      // Use the handle's documented cleanup (stops oscillators, LFOs, source
      // nodes — see SynthLoopHandle in ./synth.ts). Earlier `source.stop?.()`
      // probed AudioNode for a method only present on AudioScheduledSourceNode
      // subtypes — TS 2339 since `source: AudioNode`.
      try { lr.synth.stop() } catch { /* ignore */ }
      lr.synth = null
    }
    if (lr.synthGain) {
      try { lr.synthGain.disconnect() } catch { /* ignore */ }
      lr.synthGain = null
    }
    lr.filters = null
    lr.buffer = null
    lr.pendingAnchor = null
    lr.lastGain = 0
  }

  private bootLoops() {
    for (const def of this.getAllLoopDefs()) {
      const lr = this.registerLoopRuntime(def)
      // Skip if already attached/synthed.
      if (lr.node || lr.synth) continue
      this.attachLoop(lr)
    }
  }

  // Wire up the audio graph for one loop. Sample sources load via
  // THREE.AudioLoader (cached); synth sources build a WebAudio chain
  // immediately. Idempotent — already-attached loops short-circuit.
  private attachLoop(lr: LoopRuntime) {
    if (lr.node || lr.synth) return
    if (!this.listener || !this.ambientGain || !this.sfxGain) return
    const ctx = this.listener.context
    const isAmbient = this.categoryFor(lr.def.key) === 'ambient'
    const out = isAmbient ? this.ambientGain : this.sfxGain

    if (lr.def.src.startsWith('synth:')) {
      const fnName = lr.def.src.slice('synth:'.length)
      const fn = SYNTH_LOOPS[fnName]
      if (!fn) return

      // For object: anchors of synth loops, pipe into a PositionalAudio so
      // distance attenuation kicks in. For world / camera_motion, plain 2D.
      if (lr.def.anchor.startsWith('object:')) {
        const id = lr.def.anchor.slice('object:'.length)
        const target = this.anchors.get(id)
        if (!target) {
          lr.pendingAnchor = id
          return
        }
        const handle = fn(ctx)
        const positional = new THREE.PositionalAudio(this.listener)
        positional.setNodeSource(handle.source as AudioScheduledSourceNode)
        if (lr.def.refDist != null) positional.setRefDistance(lr.def.refDist)
        if (lr.def.maxDist != null) positional.setMaxDistance(lr.def.maxDist)
        if (lr.def.rolloff != null) positional.setRolloffFactor(lr.def.rolloff)
        positional.setDistanceModel('linear'); if (lr.def.rolloff == null) positional.setRolloffFactor(1)
        // Synth oscillators are already running inside fn(ctx); setVolume(0)
        // before adding to the scene graph so we don't briefly play at full
        // gain before the first tick computes the proper level.
        positional.setVolume(0)
        target.add(positional)
        lr.node = positional
        lr.synth = handle
        return
      }

      // 2D synth loop: source → per-loop gain → category gain → master.
      const handle = fn(ctx)
      const gain = ctx.createGain()
      gain.gain.value = 0
      handle.source.connect(gain).connect(out)
      lr.synth = handle
      lr.synthGain = gain
      return
    }

    // Sample-backed loop — load buffer, then attach a THREE.Audio (2D) or
    // THREE.PositionalAudio (object: anchor). Volume is set every frame in
    // tick() through node.setVolume().
    void this.loadBuffer(lr.def.src).then(buf => {
      if (!this.listener) return
      // Re-check anchor registration in case it appeared while the buffer
      // was loading.
      if (lr.def.anchor.startsWith('object:')) {
        const id = lr.def.anchor.slice('object:'.length)
        const target = this.anchors.get(id)
        if (!target) {
          lr.pendingAnchor = id
          lr.buffer = buf
          return
        }
        const positional = new THREE.PositionalAudio(this.listener)
        positional.setBuffer(buf)
        positional.setLoop(true)
        if (lr.def.refDist != null) positional.setRefDistance(lr.def.refDist)
        if (lr.def.maxDist != null) positional.setMaxDistance(lr.def.maxDist)
        if (lr.def.rolloff != null) positional.setRolloffFactor(lr.def.rolloff)
        positional.setDistanceModel('linear'); if (lr.def.rolloff == null) positional.setRolloffFactor(1)
        const filters = buildFiltersForParams(ctx, lr.def.params)
        // Kernel convolver (#65) appends to the filter chain for loops.
        // Serial-only — wet/dry split would require bypassing
        // THREE.Audio's internal routing; not worth the complexity.
        // Wet factor scales kernel buffer values (peak = wet), so a
        // curve carrying an impulse near t=0 + wet=0.4 acts roughly
        // like 60% dry / 40% reverb-tail.
        const chain: AudioNode[] = [...filters.nodes]
        if (lr.def.kernel && lr.def.kernel.wet > 0) {
          const conv = ctx.createConvolver()
          conv.buffer = buildKernelBuffer(ctx, lr.def.kernel)
          chain.push(conv)
        }
        // THREE.Audio.setFilters is typed for BiquadFilterNode[] but
        // accepts any AudioNode at runtime — the cast is safe.
        if (chain.length) positional.setFilters(chain as BiquadFilterNode[])
        lr.filters = filters.map
        positional.setVolume(0)
        target.add(positional)
        const ovr = this.loopOverrides.get(lr.def.key)
        if (ovr?.speed != null) positional.setPlaybackRate(ovr.speed)
        positional.play()
        lr.node = positional
        lr.buffer = buf
        return
      }
      // 2D world / camera_motion sample loop.
      const a = new THREE.Audio(this.listener)
      a.setBuffer(buf)
      a.setLoop(true)
      const filters = buildFiltersForParams(ctx, lr.def.params)
      const chain: AudioNode[] = [...filters.nodes]
      if (lr.def.kernel && lr.def.kernel.wet > 0) {
        const conv = ctx.createConvolver()
        conv.buffer = buildKernelBuffer(ctx, lr.def.kernel)
        chain.push(conv)
      }
      if (chain.length) a.setFilters(chain as BiquadFilterNode[])
      lr.filters = filters.map
      a.setVolume(0)
      const ovr = this.loopOverrides.get(lr.def.key)
      if (ovr?.speed != null) a.setPlaybackRate(ovr.speed)
      a.play()
      lr.node = a
      lr.buffer = buf
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[audio] failed to load loop sample', lr.def.key, lr.def.src, err)
    })
  }

  // Lifecycle helper for the visibility gate (commit 5).
  context(): AudioContext | null {
    return this.listener?.context ?? null
  }
}

export const audioBus = new AudioBus()
