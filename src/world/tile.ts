import { Quaternion, Vector3 } from 'three'
import { FACES, type FaceIndex } from './faces'

export const N = 2 // tiles per face edge — Phase 1 uses 2x2

export interface Tile {
  id: number
  face: FaceIndex
  u: number
  v: number
  homeFace: FaceIndex
  homeU: number
  homeV: number
  orientation: Quaternion
}

export function buildSolvedTiles(): Tile[] {
  const tiles: Tile[] = []
  let id = 0
  for (const f of FACES) {
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        tiles.push({
          id: id++,
          face: f.index,
          u,
          v,
          homeFace: f.index,
          homeU: u,
          homeV: v,
          orientation: new Quaternion(),
        })
      }
    }
  }
  return tiles
}

/**
 * Visually-solved check: the puzzle reads as "assembled" iff there exists a
 * single rigid rotation R applied uniformly to every tile. This includes the
 * canonical solved state (R = identity) and every globally-rotated variant
 * reachable via slice moves (e.g. both slices of the same axis rotated by
 * the same ±90°). Matches player expectation — if the world looks whole,
 * it is solved.
 */
export function isSolved(tiles: readonly Tile[]): boolean {
  if (tiles.length === 0) return true

  const R = tiles[0].orientation
  const homeC = new Vector3()
  const curC = new Vector3()

  for (const t of tiles) {
    // Shared orientation: q and -q represent the same rotation, so compare
    // both component-wise and with sign-flipped b.
    const q = t.orientation
    const sameSign =
      Math.abs(q.x - R.x) + Math.abs(q.y - R.y) +
      Math.abs(q.z - R.z) + Math.abs(q.w - R.w)
    const flipSign =
      Math.abs(q.x + R.x) + Math.abs(q.y + R.y) +
      Math.abs(q.z + R.z) + Math.abs(q.w + R.w)
    if (Math.min(sameSign, flipSign) > 1e-3) return false

    // Position: current centroid must equal R applied to home centroid.
    const fh = FACES[t.homeFace]
    const sH = -1 + (2 * t.homeU + 1) / N
    const tH = -1 + (2 * t.homeV + 1) / N
    homeC.copy(fh.normal).addScaledVector(fh.right, sH).addScaledVector(fh.up, tH)
    homeC.applyQuaternion(R)

    const fc = FACES[t.face]
    const sC = -1 + (2 * t.u + 1) / N
    const tC = -1 + (2 * t.v + 1) / N
    curC.copy(fc.normal).addScaledVector(fc.right, sC).addScaledVector(fc.up, tC)

    if (homeC.distanceToSquared(curC) > 1e-4) return false
  }
  return true
}
