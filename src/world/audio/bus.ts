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
  modulator?: string
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
  private cameraOrbitSpeed = 0  // 0..1 normalised, written by AudioBus tick
  private windStrengthGetter: (() => number) | null = null
  // Slice-rotation rumble: target (0|1) is set by subscriptions.ts when
  // drag||anim transitions; tick() smooths the actual value with separate
  // attack/release rates so the rumble fades in/out rather than snapping.
  private sliceRotActiveTarget = 0
  private sliceRotActive = 0

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
    const ctx = this.listener?.context
    if (!ctx || !this.sfxGain) return
    // Resume the context if the browser auto-suspended it (autoplay policy).
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ })

    if (def.src.startsWith('synth:')) {
      const fn = SYNTHS[def.src.slice('synth:'.length)]
      if (!fn) return
      fn(ctx, this.sfxGain)
      return
    }

    // Sample event — resolve the cached buffer, then schedule a fresh
    // AudioBufferSourceNode through sfxGain. Pitch jitter randomises
    // playbackRate to avoid the cloned-sample sound on repeated triggers
    // (most useful for footsteps).
    void this.loadBuffer(def.src).then(buf => {
      if (!this.sfxGain) return
      const src = ctx.createBufferSource()
      src.buffer = buf
      if (def.pitchJitter && def.pitchJitter > 0) {
        const j = def.pitchJitter
        src.playbackRate.value = 1 - j + Math.random() * (2 * j)
      }
      src.connect(this.sfxGain)
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
      const mod = lr.def.modulator ? this.modulatorValue(lr.def.modulator) : 1
      const raw = this.computeFinalGain(lr.def.key, lr.def.vol, mod)
      const finalGain = Number.isFinite(raw) ? raw : 0
      if (lr.node) lr.node.setVolume(finalGain)
      if (lr.synthGain) lr.synthGain.gain.value = finalGain
    }
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
      const mod = lr.def.modulator ? this.modulatorValue(lr.def.modulator) : 1
      lr.node.setVolume(this.computeFinalGain(lr.def.key, lr.def.vol, mod))
    }
  }

  // Loop bookkeeping. Idempotent — boot creates one runtime per definition.
  registerLoopRuntime(def: LoopDef): LoopRuntime {
    const existing = this.loops.get(def.key)
    if (existing) return existing
    const lr: LoopRuntime = { def, node: null, synth: null, synthGain: null, pendingAnchor: null, buffer: null }
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
        positional.setDistanceModel('inverse')
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
        positional.setDistanceModel('inverse')
        positional.setVolume(0)
        target.add(positional)
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
