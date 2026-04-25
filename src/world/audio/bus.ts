// Audio bus — single AudioListener attached to the camera, registry-driven
// loops + events, anchor lookup by id (Object3D refs registered from the
// scene), modulators that map per-frame state to 0..1 gain factors.
//
// Three's Audio + PositionalAudio handle distance falloff, listener-relative
// pan, AudioContext lifecycle. We add: lazy-attach when an anchor isn't
// registered yet; modulator tick; master/category mute & volume.

import * as THREE from 'three'
import registryJson from './registry.json'

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

  setMasterMute(m: boolean) { this.masterMute = m; this.applyAllVolumes() }
  setMasterVolume(v: number) { this.masterVol = v; this.applyAllVolumes() }
  setCategoryVolume(c: Category, v: number) { this.categoryVol[c] = v; this.applyAllVolumes() }
  setCategoryMute(c: Category, m: boolean) { this.categoryMute[c] = m; this.applyAllVolumes() }

  // Stub; real implementation lands in commit 2 (synth) and commits 3-4 (loops).
  play(_key: string, _opts?: { volume?: number }) { /* will be filled in commit 2 */ }

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
