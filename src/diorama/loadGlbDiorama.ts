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
import { clearColliders, registerCollider } from '../world/colliderRefs'
import { createKhrAudioEmitterPlugin, type KhrImportResult } from '../world/audio/khrAudioEmitter'
import { audioBus } from '../world/audio/bus'

/** Collapse visually-identical materials onto a single shared instance.
 *  Fingerprint includes every property the sphere-projection onBeforeCompile
 *  hook cares about: colour, PBR scalars, emission, alpha mode, texture
 *  identities (by uuid, since loader-instantiated textures are already
 *  unique per image), side. Materials with the same fingerprint are safe
 *  to share — the sphere patch is idempotent on userData.__spherePatched,
 *  so whichever of the N equivalents first reaches patchSceneForSphere
 *  wins and the rest skip. */
export function dedupeMaterials(node: THREE.Object3D): void {
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
  // Register the KHR_audio_emitter parser plugin BEFORE load so emitter
  // afterRoot fires on the loaded GLTF. baseUrl resolves audio.uri relative
  // to the glb's location (typically /diorama.glb → audio at /audio/foo.ogg).
  let absoluteBase: string | undefined
  try { absoluteBase = new URL(url, window.location.href).href } catch { /* ignore */ }
  loader.register(createKhrAudioEmitterPlugin(absoluteBase))
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

  // Collider extraction. Blender's `rubics_collider` collection ships
  // colliders with `userData.rubics_role === "collider"` (or
  // `"collider_dyn"`). We hide them from render, exclude them from the
  // walk-mode height-follow raycast (raycast = noop), and register their
  // world AABB into colliderRefs for the player-vs-world test.
  //
  // Why hide instead of remove: dynamic colliders need their matrixWorld
  // to keep updating (parent transforms / animations), which only happens
  // while the mesh remains in the scene graph. Setting visible=false
  // skips the render but keeps the matrix pipeline intact (P23: don't
  // omit a mesh that consumers — here, dynamic-AABB recompute — still
  // need to traverse).
  //
  // Why raycast=noop: the WalkControls height-follow raycast walks
  // `scene.children` to find the topmost ground surface. Without the
  // noop, an invisible cube wrapping a building would trick the player
  // into "standing on" the cube's top face.
  clearColliders()
  // Pass 1 — flag colliders before render-path traversal: visible=false
  // (skip rendering) and raycast=noop (skip the height-follow probe so a
  // building's collider cube doesn't become a roof to stand on). Collected
  // here, registered post-parenting in pass 2 once matrixWorld is final.
  const colliderQueue: { mesh: THREE.Object3D; kind: 'static' | 'dynamic' }[] = []
  gltf.scene.traverse(c => {
    const role = (c.userData && (c.userData as { rubics_role?: string }).rubics_role) || ''
    if (role !== 'collider' && role !== 'collider_dyn') return
    c.visible = false
    ;(c as THREE.Mesh).raycast = () => {}
    colliderQueue.push({ mesh: c, kind: role === 'collider_dyn' ? 'dynamic' : 'static' })
  })

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

  // Pass 2 — colliders: now that gltf.scene is parented to `root`, the
  // collider meshes' matrixWorld is final. Register their world AABB into
  // colliderRefs so WalkControls can test against them. Order matters:
  // dedupeMaterials and weldCubeNetSeams skip mesh material/geometry on
  // the hidden collider boxes (we don't render them), so registering here
  // captures the un-touched flat-net AABB which is the same coordinate
  // frame the player's flat coords live in.
  root.updateMatrixWorld(true)
  for (const { mesh, kind } of colliderQueue) registerCollider(mesh, kind)
  if (import.meta.env?.DEV && colliderQueue.length > 0) {
    const s = colliderQueue.filter(c => c.kind === 'static').length
    const d = colliderQueue.length - s
    // eslint-disable-next-line no-console
    console.log(`[diorama] colliders: ${s} static, ${d} dynamic`)
  }

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

  // Animation mixer drives every clip the exporter baked in. WYSIWYG
  // naming convention:
  //   - Clip name ends with `_once` or `_oneshot` → play once, clamp to
  //     the last frame (hold). Use this for intro flourishes, scripted
  //     beats, anything that should fire and stop.
  //   - Default → loop infinitely. Most diorama loops fall here (windmill
  //     spin, car drive cycle, ambient flapping).
  // Authored in Blender as Action names ('myAction_once' etc.) — those
  // names round-trip through gltf.animations[].name.
  const mixer = gltf.animations.length ? new THREE.AnimationMixer(gltf.scene) : null
  if (mixer) {
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip)
      const name = (clip.name ?? '').toLowerCase()
      const oneShot = name.endsWith('_once') || name.endsWith('_oneshot')
      if (oneShot) {
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity)
      }
      action.play()
    }
    if (import.meta.env?.DEV) {
      const oneShotCount = gltf.animations.filter(c =>
        (c.name ?? '').toLowerCase().match(/_(once|oneshot)$/)).length
      // eslint-disable-next-line no-console
      console.log(`[diorama] animations: ${gltf.animations.length} clip(s), ${oneShotCount} one-shot, ${gltf.animations.length - oneShotCount} looping`)
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

  // Pull KHR_audio_emitter import receipt so the caller can clean up loops
  // on diorama swap. Audio nodes registered by the importer plugin live on
  // the audio bus, NOT on the diorama subtree — removing the diorama from
  // dScene doesn't unregister them.
  const audioImport = gltf.scene.userData?.KHR_audio_emitter as KhrImportResult | undefined
  const registeredAudioKeys = audioImport?.registeredKeys ?? []
  const dispose = registeredAudioKeys.length > 0
    ? () => { for (const k of registeredAudioKeys) audioBus.unregisterLoop(k) }
    : undefined

  return { root, update, dispose, animations: gltf.animations }
}
