/**
 * Standalone bake page. Reachable at /bake/ in dev — builds a throwaway
 * imperative diorama (NO render path, NO sphere TileGrid, NO 24-pass
 * loop) and exports it via GLTFExporter, then POSTs to the dev server's
 * /__diorama/commit-glb middleware to overwrite public/diorama.glb.
 *
 * Why a separate route: the main app's sphere TileGrid renders 24×/frame
 * which stalls headless WebGL. The bake itself doesn't need rendering —
 * GLTFExporter walks the scene graph directly, materials don't need to
 * be compiled. So we mount a non-rendering React tree, kick off the
 * bake, and report the result to the DOM (so an automated runner can
 * read the verdict).
 *
 * Includes the same collider auto-generation + 4-second procedural
 * animation bake as TileGrid's saveDiorama so the on-disk glb has
 * everything ?glb=1 would have shown.
 */
import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { buildDiorama } from './diorama/buildDiorama'

type Status =
  | { phase: 'idle' }
  | { phase: 'building' }
  | { phase: 'baking' }
  | { phase: 'committing'; bytes: number; tracks: number; colliders: number }
  | { phase: 'done'; bytes: number; tracks: number; colliders: number; path: string }
  | { phase: 'error'; message: string }

async function bakeAndCommit(setStatus: (s: Status) => void) {
  setStatus({ phase: 'building' })
  // Build a clean throwaway diorama with the cube-net terrain visible.
  // skipMeadow=true so the grass meadow stays procedural-only (regenerated
  // on glb load via loadGlbDiorama → buildGrass).
  const diorama = buildDiorama({ includeTerrain: true, skipMeadow: true })
  diorama.root.updateMatrixWorld(true)

  // Strip textures from every material before export. GLTFExporter throws
  // "No valid image data found" when a texture's image hasn't loaded yet
  // — and several diorama materials use procedural textures (DataTexture,
  // CanvasTexture, lazily-loaded HDRI swatches) whose .source.data is
  // never the kind of bitmap the exporter can serialise.
  //
  // What we keep: per-material base colour, alpha mode, double-sided,
  // PBR scalars (roughness, metalness). Blender's Principled BSDF receives
  // those just fine. What we drop: every map slot (map, normalMap,
  // roughnessMap, etc.). The user can re-link maps in Blender or rely on
  // the procedural-from-code path; the bake's purpose is to give Blender
  // a parsable starting point + colliders + animations, not material
  // fidelity.
  const TEX_KEYS: readonly string[] = [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
    'emissiveMap', 'envMap', 'lightMap', 'alphaMap', 'bumpMap',
    'displacementMap', 'specularMap', 'specularIntensityMap',
    'specularColorMap', 'sheenColorMap', 'sheenRoughnessMap',
    'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
    'transmissionMap', 'thicknessMap', 'iridescenceMap',
    'iridescenceThicknessMap', 'anisotropyMap', 'gradientMap', 'matcap',
  ]
  diorama.root.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.material) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    for (const mat of mats) {
      const matRec = mat as unknown as Record<string, unknown>
      for (const k of TEX_KEYS) {
        if (matRec[k]) matRec[k] = null
      }
      mat.needsUpdate = true
    }
  })

  // Auto-generate one AABB collider per top-level prop. Skip ground /
  // terrain / road / stonepath / flowers (you walk on them) and the
  // existing _col_ prefix (idempotency safety).
  const SKIP_PREFIXES = ['ground', 'terrain', 'flower', 'road', 'stonepath', 'path', '_col_']
  const colliderGroup = new THREE.Group()
  colliderGroup.name = 'rubics_collider'
  const _box = new THREE.Box3()
  for (const child of diorama.root.children) {
    const name = (child.name || '').toLowerCase()
    if (!name || SKIP_PREFIXES.some(p => name.startsWith(p))) continue
    _box.makeEmpty().setFromObject(child)
    if (_box.isEmpty() || !isFinite(_box.min.x)) continue
    const sx = Math.max(0.02, _box.max.x - _box.min.x)
    const sy = Math.max(0.02, _box.max.y - _box.min.y)
    const sz = Math.max(0.02, _box.max.z - _box.min.z)
    const cx = (_box.min.x + _box.max.x) * 0.5
    const cy = (_box.min.y + _box.max.y) * 0.5
    const cz = (_box.min.z + _box.max.z) * 0.5
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    cube.name = `_col_${child.name}`
    cube.position.set(cx, cy, cz)
    cube.scale.set(sx, sy, sz)
    cube.userData = { rubics_role: 'collider' }
    colliderGroup.add(cube)
  }
  diorama.root.add(colliderGroup)

  // Bake procedural animations into keyframe clips. Sample 30 Hz × 4s.
  setStatus({ phase: 'baking' })
  // Sample window must cover the slowest-moving prop's full loop. The
  // car traverses BASE_W=8 world units at CAR_SPEED=0.55 u/s ≈ 14.5s
  // round-trip — anything shorter freezes it mid-road on import. 16s
  // gives a hair of overlap so the keyframe-loop wrap reads continuous.
  // Faster props (windmill spin, smoke wisps, birds) just show many
  // cycles within the window; their keyframes loop seamlessly because
  // they're periodic. ~480 keyframes per animated channel.
  const FPS = 30
  const DURATION = 16.0
  const SAMPLES = Math.round(FPS * DURATION) + 1
  const animTargets: { node: THREE.Object3D; path: string }[] = []
  diorama.root.traverse(node => {
    if (node === diorama.root) return
    if (node === colliderGroup) return
    if (node.parent === colliderGroup) return
    const lname = (node.name || '').toLowerCase()
    if (!lname) return
    if (lname.startsWith('ground') || lname.startsWith('terrain')) return
    if (lname.startsWith('_col_')) return
    animTargets.push({ node, path: node.name })
  })
  const times = new Float32Array(SAMPLES)
  for (let i = 0; i < SAMPLES; i++) times[i] = i / FPS
  const buffers = new Map<THREE.Object3D, { pos: Float32Array; rot: Float32Array; scl: Float32Array }>()
  for (const { node } of animTargets) {
    buffers.set(node, {
      pos: new Float32Array(SAMPLES * 3),
      rot: new Float32Array(SAMPLES * 4),
      scl: new Float32Array(SAMPLES * 3),
    })
  }
  for (let s = 0; s < SAMPLES; s++) {
    diorama.update(s / FPS)
    diorama.root.updateMatrixWorld(true)
    for (const { node } of animTargets) {
      const b = buffers.get(node)!
      b.pos[s * 3 + 0] = node.position.x
      b.pos[s * 3 + 1] = node.position.y
      b.pos[s * 3 + 2] = node.position.z
      b.rot[s * 4 + 0] = node.quaternion.x
      b.rot[s * 4 + 1] = node.quaternion.y
      b.rot[s * 4 + 2] = node.quaternion.z
      b.rot[s * 4 + 3] = node.quaternion.w
      b.scl[s * 3 + 0] = node.scale.x
      b.scl[s * 3 + 1] = node.scale.y
      b.scl[s * 3 + 2] = node.scale.z
    }
  }
  const FLAT_EPS = 1e-5
  const isFlat = (arr: Float32Array, stride: number): boolean => {
    for (let k = 0; k < stride; k++) {
      const ref = arr[k]
      for (let s = 1; s < SAMPLES; s++) {
        if (Math.abs(arr[s * stride + k] - ref) > FLAT_EPS) return false
      }
    }
    return true
  }
  const tracks: THREE.KeyframeTrack[] = []
  for (const { node, path } of animTargets) {
    const b = buffers.get(node)!
    if (!isFlat(b.pos, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${path}.position`, Array.from(times), Array.from(b.pos)))
    if (!isFlat(b.rot, 4)) tracks.push(new THREE.QuaternionKeyframeTrack(`${path}.quaternion`, Array.from(times), Array.from(b.rot)))
    if (!isFlat(b.scl, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${path}.scale`, Array.from(times), Array.from(b.scl)))
  }
  const clips: THREE.AnimationClip[] = []
  if (tracks.length > 0) clips.push(new THREE.AnimationClip('rubics_loop', DURATION, tracks))

  // Restore matrices to t=0 so the static export pose is sensible.
  diorama.update(0)
  diorama.root.updateMatrixWorld(true)

  // Export.
  const exporter = new GLTFExporter()
  const arrayBuffer = await new Promise<ArrayBuffer | null>(resolve => {
    exporter.parse(
      diorama.root,
      result => resolve(result instanceof ArrayBuffer ? result : null),
      err => { console.error('[bake] GLTFExporter failed:', err); resolve(null) },
      { binary: true, animations: clips },
    )
  })
  if (!arrayBuffer) {
    setStatus({ phase: 'error', message: 'GLTFExporter returned null' })
    return
  }

  setStatus({ phase: 'committing', bytes: arrayBuffer.byteLength, tracks: tracks.length, colliders: colliderGroup.children.length })
  const res = await fetch('/__diorama/commit-glb', {
    method: 'POST',
    headers: { 'Content-Type': 'model/gltf-binary' },
    body: arrayBuffer,
  })
  const payload = await res.json().catch(() => ({ ok: false, error: 'non-JSON' }))
  if (!res.ok || !payload.ok) {
    setStatus({ phase: 'error', message: `commit failed: ${JSON.stringify(payload)}` })
    return
  }
  setStatus({
    phase: 'done',
    bytes: arrayBuffer.byteLength,
    tracks: tracks.length,
    colliders: colliderGroup.children.length,
    path: payload.path,
  })
}

export function BakeRoute() {
  const [status, setStatus] = useState<Status>({ phase: 'idle' })
  useEffect(() => {
    bakeAndCommit(setStatus).catch(err => setStatus({ phase: 'error', message: String(err) }))
  }, [])
  return (
    <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#ddd', background: '#0a0d12', minHeight: '100vh' }}>
      <h1>Diorama Bake</h1>
      <pre id="bake-status" style={{ background: '#181d24', padding: 16, borderRadius: 8 }}>
        {JSON.stringify(status, null, 2)}
      </pre>
      <p style={{ opacity: 0.6, fontSize: 12 }}>
        This page builds the imperative diorama, auto-generates colliders,
        bakes a 4-second procedural animation loop, and overwrites
        public/diorama.glb via the dev-server middleware. Visit /bake/ in
        development to (re)bake. After it says <code>done</code>, reload
        ?glb=1 to see the new asset.
      </p>
    </div>
  )
}
