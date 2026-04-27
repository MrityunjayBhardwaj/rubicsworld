/**
 * Static-mesh batching for the 24-pass sphere render.
 *
 * Folds eligible diorama meshes (static, non-animated, single-material,
 * non-skinned) into one BatchedMesh per (material, attribute-signature)
 * group. The original Mesh nodes stay in the scene tree with
 * `visible = false` and `userData.__batched = true` — graph consumers
 * (audio anchor lookup by name, AnimationMixer track binding, grass
 * `groundMesh` resolver, dharana B4 P23 trap) still find them on
 * traverse, but only the BatchedMesh actually renders.
 *
 * Per-instance home-tile membership is captured as a 24-bit mask
 * (one bit per home tile from `sphereVisibility.homeTileMeshes`).
 * Phase 2 wires per-tile cull via `BatchedMesh.setVisibleAt`. Phase 1
 * leaves all instances visible and lets the existing 8-clip-plane
 * cube-net cull do its job — pixel-identical output, draw-call drop.
 *
 * Why under `diorama.root`: the per-tile loop rotates `root.quaternion`
 * 24 times per frame; making the batch a child of root means
 * `batch.matrixWorld` follows for free. Slice-rotation (`sliceQuat`)
 * applied to root.quaternion in `TileGrid` cascades to batches the
 * same way it does to plain meshes.
 *
 * Excluded from the batch (stay as plain Mesh):
 *   - sphereVisibility.alwaysVisible (animated subtrees, mixer-bound,
 *     InstancedMesh grass/flowers)
 *   - SkinnedMesh
 *   - Multi-material meshes (BatchedMesh = single material per batch)
 *   - Colliders (`userData.rubics_role`)
 *   - Geometries with morph targets (BatchedMesh has no morph path)
 *   - Meshes whose AABB doesn't overlap any home tile (dead in scene)
 */

import * as THREE from 'three'
import { BatchedMesh } from 'three'
import type { SphereVisibility } from './sphereVisibility'

export interface DioramaBatch {
  /** BatchedMeshes added to root as direct children. */
  batches: BatchedMesh[]
  /** Per-batch, per-instance 24-bit home-tile mask. Index matches the
   *  instance id returned by addInstance. */
  instanceTileMasks: Uint32Array[]
  /** Active instance count per batch (matches masks length). */
  instanceCounts: number[]
  /** Originals tagged __batched (now visible=false). */
  batchedOriginals: Set<THREE.Mesh>
  /** Detach + dispose all batches, restore original visibility. */
  dispose: () => void
}

/** Stable per-mesh key that distinguishes geometries with different
 *  attribute layouts. Without this, two meshes that share a dedupe'd
 *  material but differ in attributes (one has vertex colors, the
 *  other doesn't; one has a 2nd UV channel, the other doesn't) would
 *  fail BatchedMesh.addGeometry — same buffer schema is required. */
function geometrySignature(geom: THREE.BufferGeometry): string {
  const names = Object.keys(geom.attributes).sort()
  const parts: string[] = []
  for (const n of names) {
    const a = geom.attributes[n]
    parts.push(`${n}:${a.itemSize}:${a.normalized ? 1 : 0}`)
  }
  parts.push(`indexed:${geom.index ? 1 : 0}`)
  return parts.join('|')
}

function isMorphed(geom: THREE.BufferGeometry): boolean {
  if (geom.morphAttributes && Object.keys(geom.morphAttributes).length > 0) return true
  return false
}

export function buildBatchedDiorama(
  root: THREE.Object3D,
  vis: SphereVisibility,
): DioramaBatch | null {
  // World matrices must reflect TRS at this moment so instance matrices
  // capture the right relative-to-root pose.
  root.updateMatrixWorld(true)
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert()

  // mesh → 24-bit mask of home tiles whose AABB it overlaps.
  // Mesh that's reachable by 0 tiles → not eligible (would render to
  // nothing). Spans-multiple-tiles is normal (a tree near a seam).
  const meshToTileMask = new Map<THREE.Mesh, number>()
  for (let t = 0; t < vis.homeTileMeshes.length; t++) {
    for (const m of vis.homeTileMeshes[t]) {
      meshToTileMask.set(m, (meshToTileMask.get(m) ?? 0) | (1 << t))
    }
  }

  // Group eligible meshes by (material.uuid, geometry signature).
  type Item = { mesh: THREE.Mesh; mask: number }
  type Group = { mat: THREE.Material; sig: string; items: Item[]; vertSum: number; indexSum: number }
  const groups = new Map<string, Group>()
  let skippedAnimated = 0
  let skippedMultiMat = 0
  let skippedSkinned = 0
  let skippedCollider = 0
  let skippedMorph = 0
  let skippedNoTile = 0

  root.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    if ((m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return
    if (vis.alwaysVisible.has(m)) { skippedAnimated++; return }
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) { skippedSkinned++; return }
    if (Array.isArray(m.material)) { skippedMultiMat++; return }
    const role = (m.userData as { rubics_role?: string })?.rubics_role
    if (role === 'collider' || role === 'collider_dyn') { skippedCollider++; return }
    const geom = m.geometry as THREE.BufferGeometry | undefined
    if (!geom) return
    if (isMorphed(geom)) { skippedMorph++; return }
    const mat = m.material as THREE.Material
    if (!mat) return
    const mask = meshToTileMask.get(m) ?? 0
    if (mask === 0) { skippedNoTile++; return }
    const sig = geometrySignature(geom)
    const key = `${mat.uuid}|${sig}`
    let g = groups.get(key)
    if (!g) {
      g = { mat, sig, items: [], vertSum: 0, indexSum: 0 }
      groups.set(key, g)
    }
    g.items.push({ mesh: m, mask })
    g.vertSum += geom.attributes.position.count
    g.indexSum += geom.index ? geom.index.count : geom.attributes.position.count
  })

  if (groups.size === 0) {
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.log('[batchedDiorama] no eligible meshes — batch skipped')
    }
    return null
  }

  const batches: BatchedMesh[] = []
  const instanceTileMasks: Uint32Array[] = []
  const instanceCounts: number[] = []
  const batchedOriginals = new Set<THREE.Mesh>()
  const _m = new THREE.Matrix4()

  for (const [, g] of groups) {
    const batch = new BatchedMesh(g.items.length, g.vertSum, g.indexSum, g.mat)
    // Sphere-projection vertex displacement makes per-instance bounding
    // spheres unreliable for frustum culling. Disable batch's built-in
    // per-instance frustum cull — Phase 2's tile mask cull supersedes
    // it, and the per-tile clip planes already gate visibility.
    batch.perObjectFrustumCulled = false
    // Sphere render does its own composite — sortObjects would mutate
    // draw order frame-to-frame and could thrash transparency stacking.
    // Stable order is fine; opaque-only meshes don't benefit from it.
    batch.sortObjects = false
    // The mesh tree forces frustumCulled=false on every node for the
    // same vertex-displacement reason — match here.
    batch.frustumCulled = false
    batch.matrixAutoUpdate = false
    batch.name = `batch:${(g.mat.name || g.mat.uuid).slice(0, 24)}`
    ;(batch.userData as Record<string, unknown>).__batchedRoot = true

    const masks = new Uint32Array(g.items.length)
    let nAdded = 0
    for (const it of g.items) {
      const geom = it.mesh.geometry as THREE.BufferGeometry
      let geomId: number
      try {
        geomId = batch.addGeometry(geom)
      } catch (e) {
        // First-fit reservation overrun or attribute mismatch we didn't
        // catch with the signature check. Drop this instance, keep the
        // original Mesh visible so it still renders the legacy way.
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.warn(`[batchedDiorama] addGeometry failed for ${it.mesh.name}:`, e)
        }
        continue
      }
      const instId = batch.addInstance(geomId)
      _m.copy(rootInv).multiply(it.mesh.matrixWorld)
      batch.setMatrixAt(instId, _m)
      masks[instId] = it.mask
      it.mesh.visible = false
      ;(it.mesh.userData as Record<string, unknown>).__batched = true
      batchedOriginals.add(it.mesh)
      nAdded++
    }
    if (nAdded === 0) continue
    batches.push(batch)
    instanceTileMasks.push(masks.subarray(0, nAdded) as Uint32Array)
    instanceCounts.push(nAdded)
    root.add(batch)
  }

  if (import.meta.env?.DEV) {
    const total = batchedOriginals.size
    const draws = batches.length
    // eslint-disable-next-line no-console
    console.log(
      `[batchedDiorama] batches=${draws} instances=${total} ` +
      `skipped: animated=${skippedAnimated} multimat=${skippedMultiMat} ` +
      `skinned=${skippedSkinned} collider=${skippedCollider} ` +
      `morph=${skippedMorph} no-tile=${skippedNoTile}`,
    )
  }

  const dispose = () => {
    for (const b of batches) {
      b.removeFromParent()
      ;(b as unknown as { dispose?: () => void }).dispose?.()
    }
    for (const m of batchedOriginals) {
      m.visible = true
      delete (m.userData as Record<string, unknown>).__batched
    }
    batches.length = 0
    instanceTileMasks.length = 0
    instanceCounts.length = 0
    batchedOriginals.clear()
  }

  return { batches, instanceTileMasks, instanceCounts, batchedOriginals, dispose }
}

/** Per-tile cull: instance i visible iff its mask bit for `homeTileIdx` is set.
 *  Multi-tile meshes (mask covers >1 bit) render in every tile pass they
 *  belong to — matches the legacy per-mesh visibility behaviour where a
 *  tree on a seam shows up in both adjacent tile passes. */
export function applyBatchVisibility(
  batchInfo: DioramaBatch,
  homeTileIdx: number,
): void {
  const tileBit = 1 << homeTileIdx
  for (let b = 0; b < batchInfo.batches.length; b++) {
    const batch = batchInfo.batches[b]
    const masks = batchInfo.instanceTileMasks[b]
    const n = batchInfo.instanceCounts[b]
    for (let i = 0; i < n; i++) {
      batch.setVisibleAt(i, (masks[i] & tileBit) !== 0)
    }
  }
}

/** End-of-loop restore: every instance visible again so any post-frame
 *  render path (preview modes, screenshot, etc.) sees the full batch. */
export function restoreBatchVisibility(batchInfo: DioramaBatch): void {
  for (let b = 0; b < batchInfo.batches.length; b++) {
    const batch = batchInfo.batches[b]
    const n = batchInfo.instanceCounts[b]
    for (let i = 0; i < n; i++) batch.setVisibleAt(i, true)
  }
}
