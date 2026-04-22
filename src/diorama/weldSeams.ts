/**
 * Cube-net seam welding — Phase A (intra-mesh, flat-space snap + merge).
 *
 * Rubic's World renders the diorama as a flat cube-net authored in
 * [-4, 4] × [-3, 3] world-X / world-Z. Each face block spans a 2×2 region;
 * the sphere-projection shader (TileGrid.tsx:patchMaterialForSphere)
 * maps flat cube-net positions to cube-face positions to sphere positions.
 * The shader is deterministic + position-only: identical flat input with
 * identical per-pass uniforms produces identical sphere output.
 *
 * Seams appear when two vertices that should land on the same sphere
 * point don't have exactly identical flat coordinates. The common causes
 * are authoring drift (a face-block's right edge at x=1.9998 instead of
 * 2.0000) and duplicate vertex rings (one mesh's geometry has two verts
 * at the same position due to how it was modelled).
 *
 * Fix (intra-mesh only here):
 *   1. Snap any vertex within `eps` of a cube-net boundary line to the
 *      exact boundary value. Cube-net boundaries: X ∈ {-4,-2,0,2,4},
 *      Z ∈ {-3,-1,1,3} (matches the 2×2 face-block tiling).
 *   2. Merge-by-distance within each mesh using three's mergeVertices —
 *      quantizes positions and fuses duplicates into a single index,
 *      preserving every attribute (normal, uv, color, etc.) from the
 *      first-seen vertex of each cluster.
 *
 * Cross-mesh welding (Phase B) is not implemented here. It would only
 * close seams in home (solved) state anyway — in scrambled states, the
 * adjacency is intentionally mismatched by gameplay.
 *
 * Safety: skips InstancedMesh (grass/flowers are procedural), SkinnedMesh
 * (bone space ≠ flat cube-net space), and empty geometries. Operates in
 * world space with per-mesh inverse transforms, so per-mesh translations
 * don't skew the snap values. The diorama root's transform is neutralised
 * for the duration — same discipline as buildGrass — so TileGrid's
 * per-frame per-cell transform doesn't contaminate the snap math when
 * this is called after rendering has started.
 */
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Cube-net boundary lines — one per face-block edge.
const SEAM_XS: readonly number[] = [-4, -2, 0, 2, 4]
const SEAM_ZS: readonly number[] = [-3, -1, 1, 3]

export interface WeldStats {
  meshesVisited:   number
  meshesSnapped:   number
  meshesMerged:    number
  vertsSnapped:    number
  vertsMergedAway: number
}

export interface WeldOpts {
  /** Snap tolerance (world units). Verts within this of a seam line get
   *  pulled to the exact seam value. 1 mm (1e-3) catches typical Blender
   *  authoring drift without fusing genuinely-distinct verts. */
  snapEps?:  number
  /** Merge tolerance passed to mergeVertices. Tighter than snapEps so
   *  only near-duplicates (post-snap) collapse into one index. */
  mergeEps?: number
}

export function weldCubeNetSeams(root: THREE.Object3D, opts: WeldOpts = {}): WeldStats {
  const snapEps  = opts.snapEps  ?? 1e-3
  const mergeEps = opts.mergeEps ?? 1e-4
  const stats: WeldStats = {
    meshesVisited: 0, meshesSnapped: 0, meshesMerged: 0,
    vertsSnapped: 0,  vertsMergedAway: 0,
  }

  // Neutralise the root's transform so matrixWorld reads root-local — same
  // guard as buildGrass uses (TileGrid.tsx overwrites root.position/quat
  // every pass, so calling this post-mount without resetting pollutes
  // world-space math). No-op on the initial load where root is identity.
  const prevMatrix         = root.matrix.clone()
  const prevMatrixAutoUpd  = root.matrixAutoUpdate
  const prevPosition       = root.position.clone()
  const prevQuaternion     = root.quaternion.clone()
  const prevScale          = root.scale.clone()
  root.position.set(0, 0, 0)
  root.quaternion.identity()
  root.scale.set(1, 1, 1)
  root.matrix.identity()
  root.matrixAutoUpdate = false
  root.updateMatrixWorld(true)

  const tmpV    = new THREE.Vector3()
  const tmpInv  = new THREE.Matrix4()
  const toMerge: THREE.Mesh[] = []

  const nearestSeam = (value: number, seams: readonly number[], tol: number): number | null => {
    for (const s of seams) {
      if (Math.abs(value - s) < tol) return s
    }
    return null
  }

  try {
    root.traverse(obj => {
      const m = obj as THREE.Mesh
      if (!m.isMesh) return
      if ((m as THREE.InstancedMesh).isInstancedMesh) return
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) return
      const geom = m.geometry as THREE.BufferGeometry | undefined
      if (!geom) return
      const posAttr = geom.attributes.position as THREE.BufferAttribute | undefined
      if (!posAttr || posAttr.count === 0) return
      stats.meshesVisited++

      m.updateWorldMatrix(true, false)
      tmpInv.copy(m.matrixWorld).invert()

      // Step 1 — snap. Only meshes whose WORLD AABB contains verts near
      // a seam line on an axis are eligible for snapping on that axis. A
      // small prop entirely inside one face block (whose AABB doesn't
      // reach any seam) doesn't get snapped — keeps authoring drift
      // elsewhere in the scene from being nudged by a spurious seam pull.
      const box = new THREE.Box3().setFromBufferAttribute(posAttr).applyMatrix4(m.matrixWorld)
      const touchesSeam = (v0: number, v1: number, seams: readonly number[]): boolean => {
        for (const s of seams) {
          if (v0 <= s + snapEps && v1 >= s - snapEps) return true
        }
        return false
      }
      const straddlesX = touchesSeam(box.min.x, box.max.x, SEAM_XS)
      const straddlesZ = touchesSeam(box.min.z, box.max.z, SEAM_ZS)

      if (straddlesX || straddlesZ) {
        const posArr = posAttr.array as Float32Array
        let snappedHere = 0
        for (let i = 0; i < posAttr.count; i++) {
          tmpV.fromBufferAttribute(posAttr, i).applyMatrix4(m.matrixWorld)
          const sx = straddlesX ? nearestSeam(tmpV.x, SEAM_XS, snapEps) : null
          const sz = straddlesZ ? nearestSeam(tmpV.z, SEAM_ZS, snapEps) : null
          if (sx === null && sz === null) continue
          if (sx !== null) tmpV.x = sx
          if (sz !== null) tmpV.z = sz
          tmpV.applyMatrix4(tmpInv)
          // Only write if the round-trip actually shifted something; float
          // inverse can return bit-identical coords for already-on-seam
          // verts and we'd dirty the attribute pointlessly.
          if (
            posArr[i * 3]     !== tmpV.x ||
            posArr[i * 3 + 1] !== tmpV.y ||
            posArr[i * 3 + 2] !== tmpV.z
          ) {
            posArr[i * 3]     = tmpV.x
            posArr[i * 3 + 1] = tmpV.y
            posArr[i * 3 + 2] = tmpV.z
            snappedHere++
          }
        }
        if (snappedHere > 0) {
          posAttr.needsUpdate = true
          stats.meshesSnapped++
          stats.vertsSnapped += snappedHere
        }
      }

      toMerge.push(m)
    })

    // Step 2 — mergeVertices. Done outside the traverse so we can safely
    // replace geometries (replacing during traverse can skip siblings
    // mid-iteration depending on the three.js version).
    for (const m of toMerge) {
      const before = m.geometry.attributes.position.count
      const merged = mergeVertices(m.geometry, mergeEps)
      // mergeVertices returns a new BufferGeometry; swap in only if it
      // actually compacted anything. Preserves the original geometry's
      // references otherwise (cheaper; no dispose churn on no-op).
      const after = merged.attributes.position.count
      if (after < before) {
        m.geometry.dispose()
        m.geometry = merged
        stats.meshesMerged++
        stats.vertsMergedAway += (before - after)
      } else {
        merged.dispose()
      }
    }
  } finally {
    root.position.copy(prevPosition)
    root.quaternion.copy(prevQuaternion)
    root.scale.copy(prevScale)
    root.matrix.copy(prevMatrix)
    root.matrixAutoUpdate = prevMatrixAutoUpd
    root.updateMatrixWorld(true)
  }

  return stats
}
