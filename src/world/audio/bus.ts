// Audio bus — single AudioListener attached to the camera, registry-driven
// loops + events, anchor lookup by id (Object3D refs registered from the
// scene), modulators that map per-frame state to 0..1 gain factors.
//
// Three's Audio + PositionalAudio handle distance falloff, listener-relative
// pan, AudioContext lifecycle. We add: lazy-attach when an anchor isn't
// registered yet; modulator tick; master/category mute & volume.

import * as THREE from 'three'
import registryJson from './registry.json'
import { SYNTHS, SYNTH_LOOPS, type SynthLoopHandle } from './synth'

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
}

export interface LoopDef {
  key: string
  anchor: AnchorRef
  src: string
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
}
export interface EventDef {
  key: string
  anchor: AnchorRef
  src: string                // 'synth:<name>' or 'audio/<file>.ogg'
  pitchJitter?: number       // ± playbackRate variation for sample one-shots
}
export interface Registry {
  loops: LoopDef[]
  events: EventDef[]
}

export type Category = 'master' | 'ambient' | 'sfx'

export const REGISTRY = registryJson as Registry

type Modulator = () => number

// Per-frame `param.value = X` writes cause zipper noise — Web Audio sees
// each frame's value as an instantaneous step (sample discontinuity) and
// the result is the classic clicky/choppy artifact at frame boundaries.
// setTargetAtTime queues an exponential approach to the target at the
// audio rate; tau≈20ms tracks motion smoothly without perceptible lag
// (one-tau ≈63% closed; ~80ms fully closed).
const SMOOTH_TAU_GAIN  = 0.025
const SMOOTH_TAU_RATE  = 0.05   // playback rate likes a slightly slower ramp
const SMOOTH_TAU_FILT  = 0.04   // filter sweeps audibly chirp if too fast
function smoothSet(param: AudioParam | undefined, target: number, ctx: AudioContext, tau = SMOOTH_TAU_GAIN) {
  if (!param || !Number.isFinite(target)) return
  // Cancel any pending automations first so a slider drag doesn't queue
  // up overlapping ramps that fight each other.
  try { param.cancelScheduledValues(ctx.currentTime) } catch { /* ignore */ }
  param.setTargetAtTime(target, ctx.currentTime, tau)
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
    this.registerAnchor(id, origin)
  }

  unregisterAnchor(id: string) {
    this.anchors.delete(id)
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
      const src = ctx.createBufferSource()
      src.buffer = buf
      let rate = speedMul
      if (def.pitchJitter && def.pitchJitter > 0) {
        const j = def.pitchJitter
        rate *= 1 - j + Math.random() * (2 * j)
      }
      src.playbackRate.value = rate
      const dst: AudioNode = volMul !== 1
        ? (() => { const g = ctx.createGain(); g.gain.value = volMul; g.connect(this.sfxGain!); return g })()
        : this.sfxGain
      src.connect(dst)
      src.start()
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[audio] failed to load event sample', def.src, err)
    })
  }

  private loadBuffer(src: string): Promise<AudioBuffer> {
    const cached = this.bufferCache.get(src)
    if (cached) return cached
    const promise = new Promise<AudioBuffer>((resolve, reject) => {
      this.audioLoader.load(src, resolve, undefined, reject)
    })
    this.bufferCache.set(src, promise)
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
        const raw = muted ? 0 : this.computeFinalGain(lr.def.key, value * userVol, 1)
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
          if (src?.playbackRate) smoothSet(src.playbackRate, r, ctx, SMOOTH_TAU_RATE)
        } catch { /* ignore */ }
        const ap = lr.synth?.params?.rate
        if (ap) smoothSet(ap, r, ctx, SMOOTH_TAU_RATE)
        continue
      }

      // Filter params (lowpass / highpass / bandpass) — smooth-sweep the
      // sample-loop's BiquadFilter, OR a synth-exposed AudioParam.
      const filt = lr.filters?.[name]
      if (filt) {
        smoothSet(filt.frequency, value, ctx, SMOOTH_TAU_FILT)
        continue
      }
      const ap = lr.synth?.params?.[name]
      if (ap) smoothSet(ap, value, ctx, SMOOTH_TAU_FILT)
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

  private bootLoops() {
    for (const def of REGISTRY.loops) {
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
        if (filters.nodes.length) positional.setFilters(filters.nodes)
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
      if (filters.nodes.length) a.setFilters(filters.nodes)
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
