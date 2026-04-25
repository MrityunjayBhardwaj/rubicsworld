/**
 * Walk-mode no-go mask. A flat-net PNG (white = walkable, black = blocked)
 * mirrors the grass / flower mask infrastructure but gates PLAYER MOTION
 * instead of blade placement.
 *
 * Per-frame collision is one face classification + one pixel sample:
 *   1. Player position normalised → unit-sphere direction.
 *   2. argmax(|x|, |y|, |z|) picks the cube face the direction belongs to.
 *   3. Divide direction by that component → face-local (u, v) in [-1, 1]².
 *   4. Map (u, v) to flat-net coords via FACE_TO_BLOCK_TL.
 *   5. Sample the mask at the resulting (flatX, flatZ).
 *
 * Same MASK_HALF_W (4) / MASK_HALF_H (3) frame as buildGrass's masks, so
 * a grass-mask PNG can be reused as a starting point.
 *
 * Authoring lives in GrassPanel ("Walk" folder) using the existing
 * `/__mask/commit/walk` Vite middleware endpoint.
 */
import * as THREE from 'three'
import { FACE_TO_BLOCK_TL, COLS, ROWS, CELL } from '../diorama/DioramaGrid'
import { FACES, type FaceIndex } from './faces'

const MASK_HALF_W = (COLS * CELL) / 2  // 4
const MASK_HALF_H = (ROWS * CELL) / 2  // 3

interface WalkMaskState {
  data: ImageData | null
  threshold: number  // 0..255; pixels with luminance > this are walkable.
}

const state: WalkMaskState = {
  data: null,
  threshold: 128,
}

export const walkMaskRefs = state

export function setWalkMask(data: ImageData | null) {
  state.data = data
}

/** Public URL of the bundled default. Lives in /public so Vite serves it
 *  identically in dev + prod. Missing file ⇒ 404 ⇒ no walk gating. */
export const DEFAULT_WALK_MASK_URL = '/walk-mask.png'

/** Translate a direction on the unit sphere into flat-net coordinates
 *  (xFlat ∈ [-MASK_HALF_W, MASK_HALF_W], zFlat ∈ [-MASK_HALF_H, MASK_HALF_H]).
 *
 *  This is the JS inverse of the cube→sphere projection the shader does:
 *  the unfolded cross net's 2×2 face blocks live at known top-left cells
 *  in `FACE_TO_BLOCK_TL`, and a face-local (u, v) ∈ [-1, 1]² maps linearly
 *  into the 2-cell × 2-cell block. The face-axis orientation (right, up)
 *  comes from the FACES table — same right/up conventions used by
 *  TileGrid's per-tile transforms. */
export function sphereDirToFlat(dir: THREE.Vector3): { x: number; z: number; face: FaceIndex } {
  const ax = Math.abs(dir.x)
  const ay = Math.abs(dir.y)
  const az = Math.abs(dir.z)
  let face: FaceIndex
  if (ax >= ay && ax >= az) face = (dir.x >= 0 ? 0 : 1) as FaceIndex
  else if (ay >= ax && ay >= az) face = (dir.y >= 0 ? 2 : 3) as FaceIndex
  else face = (dir.z >= 0 ? 4 : 5) as FaceIndex

  const f = FACES[face]
  // Project onto the cube face plane (axis-aligned at distance 1 along normal):
  // scale `dir` so its component along the face normal == 1; the residual is
  // the face-local position in the right/up basis.
  const denom = dir.dot(f.normal)
  if (Math.abs(denom) < 1e-8) return { x: 0, z: 0, face }
  const k = 1 / denom
  const px = dir.x * k
  const py = dir.y * k
  const pz = dir.z * k
  const u = px * f.right.x + py * f.right.y + pz * f.right.z
  const v = px * f.up.x    + py * f.up.y    + pz * f.up.z

  // Map (u, v) ∈ [-1, 1]² to the face's 2×2 block on the flat net.
  // Block top-left is in cell coords (col, row); each cell is CELL units.
  const [tlCol, tlRow] = FACE_TO_BLOCK_TL[face]
  const blockCx = -MASK_HALF_W + (tlCol + 1) * CELL  // centre of the 2×2 block
  const blockCz = -MASK_HALF_H + (tlRow + 1) * CELL
  // Block half-width = CELL (each block is 2 cells × 2 cells).
  // Note: the cross-net's row axis is canvas-down; this approximation is
  // good for walking inside ONE face. Crossing a face seam may have a
  // small angular offset — the painter can leave a few-pixel black margin
  // around prop edges to absorb it. Better than nothing for a 6-day jam.
  const x = blockCx + u * CELL
  const z = blockCz + v * CELL
  return { x, z, face }
}

/** True if the player at this sphere direction is inside a no-go pixel.
 *  No mask loaded ⇒ never blocked (preserves prior behaviour). */
export function isWalkBlocked(dir: THREE.Vector3): boolean {
  const data = state.data
  if (!data) return false
  const { x, z } = sphereDirToFlat(dir)
  const u = (x + MASK_HALF_W) / (MASK_HALF_W * 2)
  const v = (z + MASK_HALF_H) / (MASK_HALF_H * 2)
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return true  // off-net = blocked
  const px = Math.min(data.width  - 1, Math.floor(u * data.width))
  const py = Math.min(data.height - 1, Math.floor(v * data.height))
  const i = (py * data.width + px) * 4
  const lum = (data.data[i] + data.data[i + 1] + data.data[i + 2]) / 3
  return lum <= state.threshold  // dark pixel = no-go
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__walkMask = state
}
