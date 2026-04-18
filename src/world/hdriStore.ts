import { create } from 'zustand'
import type * as THREE from 'three'

// `uniform` is local (solid-color equirect). The rest map 1:1 to drei's
// <Environment preset=...>.
export const HDRI_PRESETS = [
  'uniform',
  'apartment', 'city', 'dawn', 'forest', 'lobby',
  'night', 'park', 'studio', 'sunset', 'warehouse',
] as const
export type HdriPreset = (typeof HDRI_PRESETS)[number]

interface HdriStore {
  /** Blob URL for an uploaded HDR/EXR. Null → use `preset`. */
  url: string | null
  filename: string | null
  preset: HdriPreset

  /** scene.backgroundBlurriness (0..1) */
  blur: number
  /** scene.environmentIntensity (0..N) */
  intensity: number
  /** Y-axis rotation, radians */
  rotation: number
  /** scene.backgroundIntensity — 0 hides the skybox, 1 fully visible */
  backgroundOpacity: number
  /** When false, all direct lights (ambient / directional) are muted —
   *  the scene is illuminated only by the HDRI environment. */
  physicalLights: boolean
  /** Hex colour used when preset === 'uniform'. */
  uniformColor: string
  /** Per-material envMapIntensity — scales IBL contribution (both diffuse
   *  and specular), directly damping the Fresnel rim on grazing faces. */
  envMapIntensity: number
  /** Additive roughness offset (clamped to 1 at the material). Higher
   *  roughness blurs the specular IBL sample → softer, less contrasty rim. */
  roughnessBoost: number
  /** Master switch for the Fresnel rim. When false, the specular IBL
   *  contribution is zeroed in-shader (diffuse IBL still applies). */
  fresnelEnabled: boolean

  /** Latest loaded environment texture — populated by HDRIEnvironment so
   *  TileGrid's offscreen dScene can mirror it for IBL on the diorama. */
  envTexture: THREE.Texture | null

  setUrl: (url: string | null, filename?: string | null) => void
  setPreset: (p: HdriPreset) => void
  setBlur: (v: number) => void
  setIntensity: (v: number) => void
  setRotation: (v: number) => void
  setBackgroundOpacity: (v: number) => void
  setPhysicalLights: (v: boolean) => void
  setUniformColor: (hex: string) => void
  setEnvMapIntensity: (v: number) => void
  setRoughnessBoost: (v: number) => void
  setFresnelEnabled: (v: boolean) => void
  setEnvTexture: (t: THREE.Texture | null) => void
}

export const useHdri = create<HdriStore>(set => ({
  url: null,
  filename: null,
  preset: 'sunset',
  blur: 0.25,
  intensity: 1.0,
  rotation: 0,
  backgroundOpacity: 0,
  physicalLights: true,
  uniformColor: '#808080',
  envMapIntensity: 1.0,
  roughnessBoost: 0.0,
  fresnelEnabled: true,
  envTexture: null,

  setUrl: (url, filename) => set({ url, filename: filename ?? null }),
  setPreset: preset => set({ preset }),
  setBlur: blur => set({ blur }),
  setIntensity: intensity => set({ intensity }),
  setRotation: rotation => set({ rotation }),
  setBackgroundOpacity: backgroundOpacity => set({ backgroundOpacity }),
  setPhysicalLights: physicalLights => set({ physicalLights }),
  setUniformColor: uniformColor => set({ uniformColor }),
  setEnvMapIntensity: envMapIntensity => set({ envMapIntensity }),
  setRoughnessBoost: roughnessBoost => set({ roughnessBoost }),
  setFresnelEnabled: fresnelEnabled => set({ fresnelEnabled }),
  setEnvTexture: envTexture => set({ envTexture }),
}))
