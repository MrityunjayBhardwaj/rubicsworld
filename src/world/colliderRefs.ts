/**
 * Walk-mode AABB collision system. Two registries — static and dynamic —
 * fed by Blender's `rubics_collider` collection (see rubics_world.py:
 * `_with_collider_tags`). Each collider mesh arrives in three-js as a
 * regular GLTF node with `userData.rubics_role === "collider"` (or
 * `"collider_dyn"` for moving objects); the loader calls `register()`
 * with the right `dynamic` flag.
 *
 * Collision test is point-in-inflated-AABB: the player's world position
 * is tested against each box expanded by `radius` (Minkowski sum). The
 * "capsule effect" is free at AABB cost — six number compares per box.
 *
 * Coordinate space: boxes are stored in WORLD space, recomputed via
 * `setFromObject(mesh)` which walks the mesh's matrixWorld. Static boxes
 * are baked once at registration; dynamic boxes are rebuilt every frame
 * by `updateDynamicColliders()` so cars / NPCs etc track their transform.
 *
 * NOTE on sphere-mode coordinates: in sphere render mode, prop meshes
 * keep their FLAT cube-net positions in the scene graph — the cube→sphere
 * projection happens only in the vertex shader. So the world AABBs
 * captured here live in flat cube-net space, NOT on the planet surface.
 * The walk-mode caller therefore tests the player's FLAT-space coords
 * (via sphereDirToFlat) against these boxes — same coordinate frame as
 * the painted walk-mask. Y comes from the player's actual planet-Y
 * (height-follow result), so bridges resolve correctly.
 */
import * as THREE from 'three'

export type ColliderKind = 'static' | 'dynamic'

interface Collider {
  mesh: THREE.Object3D
  kind: ColliderKind
  box: THREE.Box3
}

const colliders: Collider[] = []

export function clearColliders() {
  colliders.length = 0
}

/** Register a collider mesh. `static` boxes are baked once from the
 *  current matrixWorld; `dynamic` boxes are rebuilt on every
 *  `updateDynamicColliders()` call. */
export function registerCollider(mesh: THREE.Object3D, kind: ColliderKind) {
  mesh.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(mesh)
  colliders.push({ mesh, kind, box })
}

/** Refresh dynamic collider AABBs from their meshes' current matrixWorld.
 *  Call once per frame BEFORE the walk-mode collision query so cars /
 *  NPCs animated this tick are tested at their up-to-date positions. */
export function updateDynamicColliders() {
  for (const c of colliders) {
    if (c.kind !== 'dynamic') continue
    c.box.setFromObject(c.mesh)
  }
}

/** True if `p` (world-space) is inside any registered collider expanded
 *  by `radius`. Six compares per box; trivially fast for the dozens of
 *  colliders a city-scale scene needs. */
export function isPointBlocked(p: THREE.Vector3, radius: number): boolean {
  for (const c of colliders) {
    const b = c.box
    if (p.x < b.min.x - radius || p.x > b.max.x + radius) continue
    if (p.y < b.min.y - radius || p.y > b.max.y + radius) continue
    if (p.z < b.min.z - radius || p.z > b.max.z + radius) continue
    return true
  }
  return false
}

export function colliderCount(): { static: number; dynamic: number } {
  let s = 0, d = 0
  for (const c of colliders) (c.kind === 'static' ? s++ : d++)
  return { static: s, dynamic: d }
}

if (typeof window !== 'undefined' && (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) {
  ;(window as unknown as Record<string, unknown>).__colliders = {
    list: colliders,
    count: colliderCount,
    isPointBlocked,
  }
}
