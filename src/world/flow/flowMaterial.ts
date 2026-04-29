/**
 * Flow material factory + shared time registry.
 *
 * `createFlowMaterial(opts)` builds a stylized animated water/fluid
 * shader you can drop on any `<mesh>`. Three flow sources are
 * supported via opts.flowSource:
 *
 *   'uv1' / 'uv2'  — read flow direction from a per-vertex attribute
 *                    (use this for the CellFluids 2 export, which packs
 *                    flow into uv2)
 *   'uniform'      — single flow vector for the whole surface (use this
 *                    on a plain `<planeGeometry>` / any geometry without
 *                    per-vertex flow data)
 *   'texture'      — sample a flow-map texture by uv0; decoded as
 *                    (rg * 2 - 1). Pass the texture via opts.flowMap.
 *
 * `attachFlowAttributes(geom, opts)` is a helper for the 'uniform' and
 * 'texture' modes — it adds zero-filled `uv1`, `uv2`, and `color`
 * attributes to a geometry that doesn't have them, so the shader's
 * varyings don't read uninitialized buffers.
 *
 * `flowTimeRegistry` collects every flow material so a single
 * `tickFlowTime(t)` call updates them all. Pair with `useFlowTime()`
 * (in flowReactHooks) for r3f-driven time, or call manually if you're
 * outside r3f.
 */

import * as THREE from 'three'
import { FLOW_FRAG, FLOW_VERT } from './flowShader'

export type FlowSource = 'uv1' | 'uv2' | 'uniform' | 'texture'

export interface FlowOptions {
  flowSource?: FlowSource
  uniformFlow?: [number, number]
  flowMap?: THREE.Texture | null
  flowMapUvScale?: [number, number]
  flowMapUvOffset?: [number, number]

  flowSpeed?: number
  noiseScale?: number
  flowStrength?: number
  flowRemap?: 0 | 1
  flipX?: boolean
  flipY?: boolean
  swapXY?: boolean

  shallowColor?: string | THREE.Color
  midColor?: string | THREE.Color
  deepColor?: string | THREE.Color
  foamColor?: string | THREE.Color
  foamThreshold?: number
  foamSoftness?: number
  colorBands?: number
  depthInfluence?: number
  highlightStrength?: number
  lightDir?: THREE.Vector3 | [number, number, number]

  side?: THREE.Side
  transparent?: boolean
}

const DEFAULTS: Required<Omit<FlowOptions, 'flowMap' | 'lightDir' | 'flowMapUvScale' | 'flowMapUvOffset' | 'side' | 'transparent' | 'uniformFlow'>> = {
  flowSource: 'uv2',
  flowSpeed: 0.35,
  noiseScale: 1.4,
  flowStrength: 0.5,
  flowRemap: 0,
  flipX: false,
  flipY: false,
  swapXY: false,
  shallowColor: '#9be9ff',
  midColor: '#3eaad6',
  deepColor: '#0f3a72',
  foamColor: '#ffffff',
  foamThreshold: 0.55,
  foamSoftness: 0.08,
  colorBands: 0.55,
  depthInfluence: 0.85,
  highlightStrength: 0.4,
}

function asColor(c: string | THREE.Color): THREE.Color {
  return c instanceof THREE.Color ? c.clone() : new THREE.Color(c)
}

function asVec3(v: THREE.Vector3 | [number, number, number] | undefined, fallback: [number, number, number]): THREE.Vector3 {
  if (!v) return new THREE.Vector3(...fallback).normalize()
  if (v instanceof THREE.Vector3) return v.clone().normalize()
  return new THREE.Vector3(...v).normalize()
}

const flowSourceCode: Record<FlowSource, number> = {
  // 0 = use uniform, 1 = uv1, 2 = uv2, 3 = texture (the shader reads
  // uFlowMapEnabled separately so the value here just disambiguates
  // the per-vertex branch).
  uniform: 0,
  uv1: 1,
  uv2: 2,
  texture: 0,
}

/** Single shared registry. Each created material registers itself so
 *  `tickFlowTime(elapsedSec)` can fan out to all of them in one call. */
const flowMaterials = new Set<THREE.ShaderMaterial>()

export function tickFlowTime(elapsedSeconds: number): void {
  for (const m of flowMaterials) {
    ;(m.uniforms.uTime.value as number) = elapsedSeconds
  }
}

/** Number of flow materials currently registered (debug helper). */
export function flowMaterialCount(): number {
  return flowMaterials.size
}

/** Build a stylized flow / water ShaderMaterial. Caller is responsible
 *  for disposal — call `disposeFlowMaterial(m)` so it's also removed
 *  from the time registry, otherwise tickFlowTime keeps writing to a
 *  dead uniform map. */
export function createFlowMaterial(opts: FlowOptions = {}): THREE.ShaderMaterial {
  const o = { ...DEFAULTS, ...opts }
  const sourceCode = flowSourceCode[o.flowSource]
  const useTexture = o.flowSource === 'texture'
  const useUniform = o.flowSource === 'uniform'
  const uniformFlow = useUniform ? (opts.uniformFlow ?? [1, 0]) : [0, 0]

  const mat = new THREE.ShaderMaterial({
    vertexShader: FLOW_VERT,
    fragmentShader: FLOW_FRAG,
    uniforms: {
      uMode:       { value: 0 },
      uTime:       { value: 0 },
      uFlowSpeed:  { value: o.flowSpeed },
      uNoiseScale: { value: o.noiseScale },
      uFlowSource: { value: sourceCode },
      uFlowRemap:  { value: o.flowRemap },
      uFlowStrength: { value: o.flowStrength },
      uFlowSign:   { value: new THREE.Vector2(o.flipX ? -1 : 1, o.flipY ? -1 : 1) },
      uFlowSwapXY: { value: o.swapXY ? 1 : 0 },
      uUniformFlow: { value: new THREE.Vector2(uniformFlow[0], uniformFlow[1]) },
      uFlowMapEnabled: { value: useTexture ? 1 : 0 },
      uFlowMap:        { value: opts.flowMap ?? null },
      uFlowMapUvScale: { value: new THREE.Vector2(...(opts.flowMapUvScale ?? [1, 1])) },
      uFlowMapUvOffset: { value: new THREE.Vector2(...(opts.flowMapUvOffset ?? [0, 0])) },
      uFoamThreshold: { value: o.foamThreshold },
      uFoamSoftness:  { value: o.foamSoftness },
      uColorBands:    { value: o.colorBands },
      uShallowColor:  { value: asColor(o.shallowColor) },
      uMidColor:      { value: asColor(o.midColor) },
      uDeepColor:     { value: asColor(o.deepColor) },
      uFoamColor:     { value: asColor(o.foamColor) },
      uDepthInfluence:    { value: o.depthInfluence },
      uHighlightStrength: { value: o.highlightStrength },
      uLightDir: { value: asVec3(opts.lightDir, [0.4, 0.8, 0.2]) },
    },
    vertexColors: true,
    side: opts.side ?? THREE.DoubleSide,
    transparent: opts.transparent ?? false,
  })
  flowMaterials.add(mat)
  return mat
}

/** Remove a flow material from the time registry and dispose its GL
 *  resources. Always pair with createFlowMaterial. */
export function disposeFlowMaterial(mat: THREE.ShaderMaterial): void {
  flowMaterials.delete(mat)
  mat.dispose()
}

/** Geometry that wasn't authored with uv1/uv2/color (e.g. a plain
 *  PlaneGeometry / BoxGeometry / loaded glTF without flow data) needs
 *  these attributes synthesized before going through the flow shader,
 *  otherwise the GLSL `attribute vec2 uv1` reads garbage and `color`
 *  varies wildly per draw — a P-class silent-failure (vertices
 *  flicker, foam appears at random). Pass the geometry through this
 *  helper before assigning the flow material. */
export function attachFlowAttributes(
  geom: THREE.BufferGeometry,
  opts: { uv1Scale?: number; depthRadial?: boolean } = {},
): void {
  const vCount = geom.attributes.position.count
  if (!geom.attributes.uv) {
    // Not all primitive geometries auto-generate uv (BoxGeometry does,
    // SphereGeometry does, but a custom build may not). Best effort:
    // generate a planar XY-projection. Caller should ideally supply
    // proper UVs for the texture-sampling path.
    const uv = new Float32Array(vCount * 2)
    const pos = geom.attributes.position.array as Float32Array
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity
    for (let i = 0; i < vCount; i++) {
      const x = pos[i * 3 + 0], y = pos[i * 3 + 1]
      if (x < xmin) xmin = x; if (x > xmax) xmax = x
      if (y < ymin) ymin = y; if (y > ymax) ymax = y
    }
    const sx = 1 / Math.max(1e-5, xmax - xmin)
    const sy = 1 / Math.max(1e-5, ymax - ymin)
    for (let i = 0; i < vCount; i++) {
      uv[i * 2 + 0] = (pos[i * 3 + 0] - xmin) * sx
      uv[i * 2 + 1] = (pos[i * 3 + 1] - ymin) * sy
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  }
  if (!geom.attributes.uv1) {
    const baseUv = geom.attributes.uv.array as Float32Array
    const scale = opts.uv1Scale ?? 1.7
    const uv1 = new Float32Array(vCount * 2)
    for (let i = 0; i < vCount * 2; i++) uv1[i] = baseUv[i] * scale
    geom.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2))
  }
  if (!geom.attributes.uv2) {
    geom.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(vCount * 2), 2))
  }
  if (!geom.attributes.color) {
    const baseUv = geom.attributes.uv.array as Float32Array
    const col = new Float32Array(vCount * 4)
    for (let i = 0; i < vCount; i++) {
      let depth = 0
      if (opts.depthRadial) {
        const cx = baseUv[i * 2 + 0] - 0.5
        const cz = baseUv[i * 2 + 1] - 0.5
        depth = Math.min(1, Math.sqrt(cx * cx + cz * cz) * 1.4)
      }
      col[i * 4 + 0] = 0
      col[i * 4 + 1] = depth
      col[i * 4 + 2] = 0
      col[i * 4 + 3] = 1
    }
    geom.setAttribute('color', new THREE.BufferAttribute(col, 4))
  }
}
