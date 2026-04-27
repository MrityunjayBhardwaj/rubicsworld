/**
 * Per-tile mesh visibility for the 24-pass sphere render.
 *
 * The sphere render redraws the entire dScene 24 times, each pass clipped
 * to a 1×1 patch of the cube-net. Most diorama meshes (a tree, a building,
 * a fence) only intersect 1–2 of those 24 home patches — yet today we
 * still pay vertex transform + clip-discard for the full mesh on every
 * pass. AABB-test each mesh against each home-tile box once at build
 * time, then per-tile-pass only flip `.visible = true` for the meshes
 * that actually contribute. Three.js skips invisible meshes during
 * render, so this is a pure perf win with pixel-identical output.
 *
 * Animated meshes (windmill_wings, smoke_puff_*, bird_*, car) and
 * sphere-wide instanced meshes (grass blades) move/span beyond a fixed
 * AABB, so they're marked "always visible" and never gated.
 *
 * P23 mitigation: this only flips the `.visible` flag — the scene tree
 * is unchanged. AnimationMixer track bindings, audio anchor lookups,
 * and grass groundMesh resolution all run at build/swap time and don't
 * see the per-frame visibility flips.
 */

import * as THREE from 'three'
import { CELL, FACE_TO_BLOCK_TL } from './DioramaGrid'
import { HALF_W, HALF_H } from './buildDiorama'

export interface SphereVisibility {
  /** Index = homeFace*4 + homeV*2 + homeU. Each entry: meshes whose AABB
   *  overlaps that home tile's 1×1 cube-net patch. */
  homeTileMeshes: THREE.Mesh[][]
  /** Animated / sphere-wide / unknown-AABB meshes that bypass tile gating. */
  alwaysVisible: Set<THREE.Mesh>
  /** All meshes the patcher walked, for end-of-loop restoration. */
  allMeshes: THREE.Mesh[]
  /** InstancedMesh subset that holds grass + flower blades. Carried
   *  separately so the per-tile loop can hide just THESE for back-face
   *  tiles (where the diorama models still render but the heavy
   *  thousands-of-blades instanced pass would be wasted on a hidden
   *  hemisphere). Matched by name: 'grass', 'flower-*'. */
  grassMeshes: THREE.InstancedMesh[]
}

// Names whose subtrees are animated (per-frame transform mutation makes
// the build-time AABB unreliable). Pattern matches both the Blender-side
// names and the imperative-build names in buildDiorama.
const ANIM_NAME_RX = /^(windmill_wings|smoke_puff_|bird_|car|flock|birds_flock|grass|flower|meadow)/i

function homeTileBox(face: number, u: number, v: number, out: THREE.Box3): THREE.Box3 {
  const tl = FACE_TO_BLOCK_TL[face]
  const col = tl[0] + u
  const row = tl[1] + v
  const cx = -HALF_W + (col + 0.5) * CELL
  const cz = -HALF_H + (row + 0.5) * CELL
  const half = CELL / 2
  // Y span deliberately huge — meshes can rise tall above the cube-net
  // ground plane. Tile gating is purely XZ.
  out.min.set(cx - half, -1e3, cz - half)
  out.max.set(cx + half, 1e3, cz + half)
  return out
}

export function buildSphereVisibility(
  root: THREE.Object3D,
  animations: THREE.AnimationClip[] = [],
): SphereVisibility {
  // Force matrix sync — child meshes' matrixWorld must reflect their
  // current TRS, not whatever was last computed.
  root.updateMatrixWorld(true)

  const allMeshes: THREE.Mesh[] = []
  root.traverse(o => {
    if ((o as THREE.Mesh).isMesh) allMeshes.push(o as THREE.Mesh)
  })

  const alwaysVisible = new Set<THREE.Mesh>()

  // Pattern-match: any ancestor with an animated name marks this mesh as
  // always-visible.
  for (const m of allMeshes) {
    let n: THREE.Object3D | null = m
    while (n) {
      if (n.name && ANIM_NAME_RX.test(n.name)) { alwaysVisible.add(m); break }
      n = n.parent
    }
  }

  // Mixer track bindings: walk every clip's tracks, resolve the bound
  // node, mark all descendant meshes as always-visible. This catches
  // any animated subtree the regex missed (e.g. custom Blender names).
  for (const clip of animations) {
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name)
      const nodeName = parsed.nodeName
      if (!nodeName) continue
      const node = THREE.PropertyBinding.findNode(root, nodeName) as THREE.Object3D | undefined
      if (!node) continue
      node.traverse((o: THREE.Object3D) => {
        if ((o as THREE.Mesh).isMesh) alwaysVisible.add(o as THREE.Mesh)
      })
    }
  }

  // InstancedMesh covers thousands of instances spanning the whole
  // sphere (grass, flowers); per-instance AABB testing isn't worth it.
  // Grass + flower buckets are picked out separately so the per-tile
  // loop can hide just THESE for back-face tiles (the heavy ones)
  // while keeping diorama models visible.
  const grassMeshes: THREE.InstancedMesh[] = []
  const GRASS_NAME_RX = /^(grass|flower-)/i
  for (const m of allMeshes) {
    if ((m as THREE.InstancedMesh).isInstancedMesh) {
      alwaysVisible.add(m)
      if (m.name && GRASS_NAME_RX.test(m.name)) {
        grassMeshes.push(m as THREE.InstancedMesh)
      }
    }
  }

  const homeTileMeshes: THREE.Mesh[][] = Array.from({ length: 24 }, () => [])
  const tBox = new THREE.Box3()
  const meshBox = new THREE.Box3()
  const meshLocalBox = new THREE.Box3()

  for (let face = 0; face < 6; face++) {
    for (let v = 0; v < 2; v++) {
      for (let u = 0; u < 2; u++) {
        const idx = face * 4 + v * 2 + u
        homeTileBox(face, u, v, tBox)
        for (const m of allMeshes) {
          if (alwaysVisible.has(m)) continue
          const geom = m.geometry as THREE.BufferGeometry | undefined
          if (!geom) continue
          if (!geom.boundingBox) geom.computeBoundingBox()
          if (!geom.boundingBox) continue
          meshLocalBox.copy(geom.boundingBox)
          meshBox.copy(meshLocalBox).applyMatrix4(m.matrixWorld)
          if (tBox.intersectsBox(meshBox)) {
            homeTileMeshes[idx].push(m)
          }
        }
      }
    }
  }

  if (import.meta.env?.DEV) {
    const counts = homeTileMeshes.map(l => l.length)
    const sum = counts.reduce((a, b) => a + b, 0)
    const max = Math.max(...counts)
    const min = Math.min(...counts)
    const gated = allMeshes.length - alwaysVisible.size
    // eslint-disable-next-line no-console
    console.log(
      `[sphereVisibility] meshes=${allMeshes.length} ` +
      `gated=${gated} alwaysVisible=${alwaysVisible.size} | ` +
      `per-tile mesh counts: total=${sum}/24-tiles min=${min} max=${max} avg=${(sum / 24).toFixed(1)}`,
    )
  }

  return { homeTileMeshes, alwaysVisible, allMeshes, grassMeshes }
}

/** Apply visibility for the given home tile index. Caller is responsible
 *  for restoring at end-of-frame via `restoreSphereVisibility`.
 *
 *  Skips meshes tagged `userData.__batched = true` — those are folded
 *  into a BatchedMesh by `buildBatchedDiorama` and must stay
 *  `visible = false` permanently so the batch is the sole renderer.
 *  Re-showing them here would double-draw the geometry. The batch's
 *  own per-tile cull (applyBatchVisibility) handles the per-pass
 *  visibility for batched instances. */
export function applySphereVisibility(vis: SphereVisibility, homeTileIdx: number): void {
  for (const m of vis.allMeshes) {
    if ((m.userData as { __batched?: boolean }).__batched) continue
    m.visible = false
  }
  for (const m of vis.alwaysVisible) {
    if ((m.userData as { __batched?: boolean }).__batched) continue
    m.visible = true
  }
  const list = vis.homeTileMeshes[homeTileIdx]
  if (list) {
    for (const m of list) {
      if ((m.userData as { __batched?: boolean }).__batched) continue
      m.visible = true
    }
  }
}

/** End-of-loop restore: every non-batched mesh visible again so
 *  traversal-based consumers (audio anchors, grass lookup) see the full
 *  tree on the next scene scan. Batched originals keep visible=false —
 *  graph consumers still find them by name/track binding (the tree is
 *  intact), but they don't render. */
export function restoreSphereVisibility(vis: SphereVisibility): void {
  for (const m of vis.allMeshes) {
    if ((m.userData as { __batched?: boolean }).__batched) continue
    m.visible = true
  }
}
