import { Quaternion } from 'three'
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

export function isSolved(tiles: readonly Tile[]): boolean {
  for (const t of tiles) {
    if (t.face !== t.homeFace || t.u !== t.homeU || t.v !== t.homeV) return false
    // orientation check: identity within epsilon
    const q = t.orientation
    if (Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) > 1e-4) return false
  }
  return true
}
