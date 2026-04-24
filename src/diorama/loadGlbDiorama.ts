/**
 * glTF-loaded diorama path. Parallel to buildDiorama's imperative output —
 * same DioramaScene shape — so TileGrid can treat either source uniformly.
 *
 * On load: wraps gltf.scene in a root group, spins up an AnimationMixer for
 * any embedded clips (Blender F-curves, armatures, shape keys), and adds the
 * procedural meadow on top. The meadow's AABB exclusion walks root children
 * by name — preserve `pond`/`trees`/`road`/etc. in Blender's outliner for
 * the exclusion to stay automatic.
 *
 * Returns null on fetch/parse failure so callers can fall back to the
 * imperative build without blowing up the mount.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { DioramaScene } from './buildDiorama'
import { buildGrass, grassRefs } from './buildGrass'
import { weldCubeNetSeams } from './weldSeams'

/** Collapse visually-identical materials onto a single shared instance.
 *  Fingerprint includes every property the sphere-projection onBeforeCompile
 *  hook cares about: colour, PBR scalars, emission, alpha mode, texture
 *  identities (by uuid, since loader-instantiated textures are already
 *  unique per image), side. Materials with the same fingerprint are safe
 *  to share — the sphere patch is idempotent on userData.__spherePatched,
 *  so whichever of the N equivalents first reaches patchSceneForSphere
 *  wins and the rest skip. */
function dedupeMaterials(node: THREE.Object3D): void {
  const canonical = new Map<string, THREE.Material>()
  let dedupedCount = 0
  let totalBefore = 0
  node.traverse(obj => {
    const m = obj as THREE.Mesh
    if (!m.isMesh) return
    const pick = (mat: THREE.Material): THREE.Material => {
      totalBefore++
      const key = materialFingerprint(mat)
      const existing = canonical.get(key)
      if (existing) { dedupedCount++; return existing }
      canonical.set(key, mat)
      return mat
    }
    if (Array.isArray(m.material)) m.material = m.material.map(pick)
    else if (m.material) m.material = pick(m.material)
  })
  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[diorama] material dedup: ${totalBefore} → ${canonical.size} unique (-${dedupedCount} duplicates)`)
  }
}

function materialFingerprint(mat: THREE.Material): string {
  // Work in the common PBR superset. Non-standard materials keep their own
  // reference (key falls back on uuid).
  if (!(mat instanceof THREE.MeshStandardMaterial) &&
      !(mat instanceof THREE.MeshPhysicalMaterial)) {
    return `uuid:${mat.uuid}`
  }
  const parts = [
    mat.type,
    mat.color.getHex().toString(16),
    mat.roughness.toFixed(3),
    mat.metalness.toFixed(3),
    mat.emissive.getHex().toString(16),
    mat.emissiveIntensity.toFixed(3),
    mat.opacity.toFixed(3),
    mat.transparent ? 'T' : 'O',
    mat.side.toString(),
    mat.alphaTest.toFixed(3),
    mat.map?.uuid ?? '-',
    mat.normalMap?.uuid ?? '-',
    mat.roughnessMap?.uuid ?? '-',
    mat.metalnessMap?.uuid ?? '-',
    mat.emissiveMap?.uuid ?? '-',
    mat.aoMap?.uuid ?? '-',
    mat.alphaMap?.uuid ?? '-',
  ]
  if (mat instanceof THREE.MeshPhysicalMaterial) {
    parts.push(
      mat.clearcoat.toFixed(3),
      mat.transmission.toFixed(3),
      mat.ior.toFixed(3),
      mat.sheen.toFixed(3),
    )
  }
  return parts.join('|')
}

export async function loadGlbDiorama(
  url: string,
  opts: { includeMeadow?: boolean } = {},
): Promise<DioramaScene | null> {
  const { includeMeadow = true } = opts
  const loader = new GLTFLoader()
  let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>
  try {
    gltf = await loader.loadAsync(url)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[diorama] GLB load failed, falling back to imperative:', url, e)
    return null
  }

  // Defensive check — a stub glb (only the root node, no children) produces
  // a blank planet and silently looks "broken" unless you know to check.
  // Treat it the same as a fetch failure so the caller falls back cleanly.
  let meshCount = 0
  gltf.scene.traverse(c => { if ((c as THREE.Mesh).isMesh) meshCount++ })
  if (meshCount === 0) {
    // eslint-disable-next-line no-console
    console.warn('[diorama] GLB contains zero meshes; falling back to imperative:', url)
    return null
  }

  const root = new THREE.Group()
  root.name = 'diorama'
  // Keep frustum culling off to match the imperative build — sphere
  // projection moves vertices far from their geometry bounding sphere, which
  // would otherwise cull edge-of-screen meshes.
  gltf.scene.traverse(c => { c.frustumCulled = false })

  // Deduplicate materials. Blender's glTF exporter hands every mesh its own
  // material instance even when they're visually identical — a 150-mesh
  // diorama commonly comes in with 100+ unique materials. Each unique
  // material is a separate draw call (sphere mode renders the scene 24×
  // per frame — so 100 materials × 24 passes = 2.4K draws/frame just for
  // props). Each unique material also fires its own onBeforeCompile on
  // first render, multiplying the sphere-projection shader-compile cost.
  // Collapsing by visual fingerprint brings that down to the handful of
  // truly distinct looks in the scene.
  dedupeMaterials(gltf.scene)

  root.add(gltf.scene)

  // Cube-net seam weld (Phase A — intra-mesh, flat-space).
  // Vertices near face-block boundary lines get snapped to exact seam
  // coordinates so the deterministic sphere-projection shader produces
  // identical output on both sides of the seam. Duplicate rings within
  // the same mesh are then merged via mergeVertices — pure index
  // compaction for exact-equal positions, all attributes (colour, uv,
  // normal, ...) preserved from the first-seen vert. Runs AFTER dedupe
  // so it sees the final material layout but BEFORE buildGrass, so the
  // ground's vertex-colour density layer operates on the welded topology.
  const weldStats = weldCubeNetSeams(root)
  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(
      `[diorama] seam weld: ${weldStats.vertsSnapped} snapped in ${weldStats.meshesSnapped}/${weldStats.meshesVisited} meshes; ` +
      `${weldStats.vertsMergedAway} merged in ${weldStats.meshesMerged} meshes`,
    )
  }

  // Recompute per-vertex averaged normals on the ground/terrain. Two
  // reasons this closes visible face-to-face seams (e.g. A↔F) that the
  // sphere-projection shader alone can't:
  //   1. Blender exports flat-shaded or tight-auto-smooth normals for
  //      heightmap terrains — each triangle has its own normal, producing
  //      cross-seam lighting jumps where face A's last triangle row meets
  //      face F's first row.
  //   2. weldCubeNetSeams' mergeVertices step keeps the first-seen
  //      vertex's normal per cluster; at seam duplicates, that normal
  //      represents only one side's triangle, leaving a pinch on the other.
  // computeVertexNormals averages adjacent-triangle normals per vertex,
  // smoothing shading across triangles AND across face seams in one pass.
  // Applied only to the ground (name starts with ground/terrain) — other
  // meshes keep their authored normals on purpose (trees, buildings).
  let ground: THREE.Mesh | null = null
  root.traverse(o => {
    if (ground) return
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const nm = (m.name || '').toLowerCase()
    if (nm.startsWith('ground') || nm.startsWith('terrain')) ground = m
  })
  if (ground) {
    (ground as THREE.Mesh).geometry.computeVertexNormals()
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.log(`[diorama] recomputed ground normals on "${(ground as THREE.Mesh).name}"`)
    }
  }

  // Animation mixer drives every clip the exporter baked in. Plays on loop;
  // individual actions can be gated via mixer.clipAction(clip).setLoop(...)
  // if that becomes needed.
  const mixer = gltf.animations.length ? new THREE.AnimationMixer(gltf.scene) : null
  if (mixer) {
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip)
      action.setLoop(THREE.LoopRepeat, Infinity)
      action.play()
    }
  }

  // Meadow rides on top. AABB exclusion walks root's named children — trees,
  // pond, road, etc. — so blender outliner naming carries over.
  let grass: ReturnType<typeof buildGrass> | null = null
  if (includeMeadow) {
    // Thread the currently-loaded painted mask (if any) through to buildGrass
    // so hot-reload swaps don't silently drop back to AABB exclusion. Null
    // ⇒ default AABB path.
    grass = buildGrass(root, { maskImage: grassRefs.activeMask })
    for (const m of grass.meshes) root.add(m)
  }

  // Mixer wants FRAME DELTA, not absolute elapsed time. Track the previous
  // elapsed so we can subtract. Cap the delta to 100 ms to avoid a huge
  // lurch when the tab refocuses after idling (mixer otherwise plays the
  // entire skipped interval in one frame).
  let last = 0
  const update = (elapsed: number) => {
    const delta = Math.min(0.1, Math.max(0, elapsed - last))
    last = elapsed
    if (mixer) mixer.update(delta)
    grass?.update(elapsed)
  }

  return { root, update }
}
