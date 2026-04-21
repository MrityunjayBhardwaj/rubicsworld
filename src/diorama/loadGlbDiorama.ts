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
import { buildGrass } from './buildGrass'

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
  root.add(gltf.scene)

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
    grass = buildGrass(root)
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
