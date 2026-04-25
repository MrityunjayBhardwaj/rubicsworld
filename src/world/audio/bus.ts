// Audio bus — single AudioListener attached to the camera, registry-driven
// loops + events, anchor lookup by id (Object3D refs registered from the
// scene), modulators that map per-frame state to 0..1 gain factors.
//
// Three's Audio + PositionalAudio handle distance falloff, listener-relative
// pan, AudioContext lifecycle. We add: lazy-attach when an anchor isn't
// registered yet; modulator tick; master/category mute & volume.

import * as THREE from 'three'
import registryJson from './registry.json'
import { SYNTHS } from './synth'

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
  src: string  // 'synth:<name>' for now
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
  node: THREE.Audio | THREE.PositionalAudio | null
  pendingAnchor: string | null  // anchor id we're waiting on
  buffer: AudioBuffer | null
}

class AudioBus {
  listener: THREE.AudioListener | null = null
  private anchors = new Map<string, THREE.Object3D>()
  private modulators = new Map<string, Modulator>()
  private loops = new Map<string, LoopRuntime>()
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

  setMasterMute(m: boolean) { this.masterMute = m; this.applyGraphGains(); this.applyAllVolumes() }
  setMasterVolume(v: number) { this.masterVol = v; this.applyGraphGains(); this.applyAllVolumes() }
  setCategoryVolume(c: Category, v: number) { this.categoryVol[c] = v; this.applyGraphGains(); this.applyAllVolumes() }
  setCategoryMute(c: Category, m: boolean) { this.categoryMute[c] = m; this.applyGraphGains(); this.applyAllVolumes() }

  // Trigger an event from registry by key. Currently only `synth:*` sources
  // are supported (commit 2). Sample-based events would dispatch similarly.
  play(key: string, _opts?: { volume?: number }) {
    const def = REGISTRY.events.find(e => e.key === key)
    if (!def) return
    const ctx = this.listener?.context
    if (!ctx || !this.sfxGain) return
    if (def.src.startsWith('synth:')) {
      const fn = SYNTHS[def.src.slice('synth:'.length)]
      if (!fn) return
      // Resume the context if the browser auto-suspended it (autoplay policy).
      if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ })
      fn(ctx, this.sfxGain)
    }
  }

  // Internal — called by a per-frame tick.
  tick() {
    if (!this.listener) return
    // Update loop volumes from modulators.
    for (const lr of this.loops.values()) {
      if (!lr.node || !lr.def.modulator) continue
      const mod = this.modulatorValue(lr.def.modulator)
      const finalGain = this.computeFinalGain(lr.def.key, lr.def.vol, mod)
      lr.node.setVolume(finalGain)
    }
  }

  private modulatorValue(name: string): number {
    if (name === 'windStrength' && this.windStrengthGetter) {
      // Wind uniform ranges 0..4 in Leva; map to 0..1 with a soft knee.
      const ws = this.windStrengthGetter()
      return Math.min(1, ws / 2.0)
    }
    if (name === 'cameraOrbitSpeed') return this.cameraOrbitSpeed
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
    this.masterGain.gain.value = masterEffective
    this.ambientGain.gain.value = ambientEffective
    this.sfxGain.gain.value = sfxEffective
  }

  private applyAllVolumes() {
    for (const lr of this.loops.values()) {
      if (!lr.node) continue
      const mod = lr.def.modulator ? this.modulatorValue(lr.def.modulator) : 1
      lr.node.setVolume(this.computeFinalGain(lr.def.key, lr.def.vol, mod))
    }
  }

  // Loop bookkeeping — buffers loaded in commit 3+.
  registerLoopRuntime(def: LoopDef): LoopRuntime {
    const existing = this.loops.get(def.key)
    if (existing) return existing
    const lr: LoopRuntime = { def, node: null, pendingAnchor: null, buffer: null }
    this.loops.set(def.key, lr)
    return lr
  }

  getAnchor(id: string): THREE.Object3D | undefined {
    return this.anchors.get(id)
  }

  // Placeholder — fully wired when buffers exist (commits 3-4).
  private attachLoop(_lr: LoopRuntime) { /* commit 3-4 */ }

  // Lifecycle helper for the visibility gate (commit 5).
  context(): AudioContext | null {
    return this.listener?.context ?? null
  }
}

export const audioBus = new AudioBus()
