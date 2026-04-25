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

export interface LoopDef {
  key: string
  anchor: AnchorRef
  src: string
  vol: number
  // One named modulator OR a list combined multiplicatively. e.g.
  // `['windStrength', 'awayFromPond']` makes the ambient wind fade in two
  // dimensions: dialled-down wind strength AND player proximity to water.
  modulator?: string | string[]
  refDist?: number
  maxDist?: number
  rolloff?: number
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

interface LoopRuntime {
  def: LoopDef
  // Sample-backed loops use a THREE.Audio / PositionalAudio (whose internal
  // gain we set via setVolume each tick).
  node: THREE.Audio | THREE.PositionalAudio | null
  // Synth-backed loops bypass three.js entirely and own a raw GainNode that
  // the bus modulates per frame.
  synth: SynthLoopHandle | null
  synthGain: GainNode | null
  pendingAnchor: string | null  // anchor id we're waiting on (sample loops)
  buffer: AudioBuffer | null
  // Last computed gain (post-modulator, post-override, post-master). Read
  // by the visualiser to draw a live level meter at each anchor.
  lastGain: number
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

  // Per-sound user overrides driven by the Audio panel. Each value is a
  // multiplier applied on top of the registry's base vol / a 1.0 default
  // playbackRate. mute=true forces gain to 0 regardless of vol.
  private loopOverrides = new Map<string, { vol?: number; speed?: number; mute?: boolean }>()
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

  // ── Per-sound overrides ─────────────────────────────────────────────
  setLoopOverride(key: string, override: { vol?: number; speed?: number; mute?: boolean }) {
    const prev = this.loopOverrides.get(key) ?? {}
    const next = { ...prev, ...override }
    this.loopOverrides.set(key, next)
    // Speed change must be pushed to the live source NOW (sample loops
    // continue playing — there's no per-tick step that re-applies it).
    const lr = this.loops.get(key)
    if (lr?.node && next.speed != null) {
      try { lr.node.setPlaybackRate(next.speed) } catch { /* ignore */ }
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
    // Smooth slice-rumble: 200ms attack, 400ms release. Asymmetric so the
    // rumble swells in quickly when the player starts dragging but fades
    // gracefully on release rather than cutting hard.
    {
      const target = this.sliceRotActiveTarget
      const cur = this.sliceRotActive
      const tau = target > cur ? 0.20 : 0.40
      const k = Math.min(1, dt / tau)
      this.sliceRotActive = cur + (target - cur) * k
    }
    // Update loop volumes from modulators. AudioParam.value rejects non-
    // finite — guard at the assignment site so an early-frame race that
    // produces NaN/Infinity (e.g. modulator reading an uninitialised
    // uniform) doesn't throw.
    for (const lr of this.loops.values()) {
      const ovr = this.loopOverrides.get(lr.def.key)
      const baseVol = lr.def.vol * (ovr?.vol ?? 1)
      const muted = ovr?.mute === true
      const mod = this.combinedModulator(lr.def.modulator)
      const raw = muted ? 0 : this.computeFinalGain(lr.def.key, baseVol, mod)
      const finalGain = Number.isFinite(raw) ? raw : 0
      lr.lastGain = finalGain
      if (lr.node) lr.node.setVolume(finalGain)
      if (lr.synthGain) lr.synthGain.gain.value = finalGain
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
    if (!this.masterGain || !this.ambientGain || !this.sfxGain) return
    const masterEffective = (this.masterMute || this.categoryMute.master) ? 0 : this.masterVol * this.categoryVol.master
    const ambientEffective = this.categoryMute.ambient ? 0 : this.categoryVol.ambient
    const sfxEffective = this.categoryMute.sfx ? 0 : this.categoryVol.sfx
    this.masterGain.gain.value = Number.isFinite(masterEffective) ? masterEffective : 0
    this.ambientGain.gain.value = Number.isFinite(ambientEffective) ? ambientEffective : 0
    this.sfxGain.gain.value = Number.isFinite(sfxEffective) ? sfxEffective : 0
  }

  private applyAllVolumes() {
    for (const lr of this.loops.values()) {
      if (!lr.node) continue
      const ovr = this.loopOverrides.get(lr.def.key)
      const baseVol = lr.def.vol * (ovr?.vol ?? 1)
      const muted = ovr?.mute === true
      const mod = this.combinedModulator(lr.def.modulator)
      lr.node.setVolume(muted ? 0 : this.computeFinalGain(lr.def.key, baseVol, mod))
    }
  }

  // Loop bookkeeping. Idempotent — boot creates one runtime per definition.
  registerLoopRuntime(def: LoopDef): LoopRuntime {
    const existing = this.loops.get(def.key)
    if (existing) return existing
    const lr: LoopRuntime = { def, node: null, synth: null, synthGain: null, pendingAnchor: null, buffer: null, lastGain: 0 }
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
