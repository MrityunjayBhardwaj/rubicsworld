import { Vector3, Quaternion } from 'three'
import { FACES, type FaceIndex } from './faces'
import { N, type Tile } from './tile'

export type Axis = 'x' | 'y' | 'z'
export type Direction = 1 | -1

export const AXIS_VEC: Record<Axis, Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
}

// Logical centroid of (face, u, v) in cube-local space.
// Always has one component = ±1 (face normal direction) and two = ±0.5 for N=2.
export function tileCentroid(face: FaceIndex, u: number, v: number): Vector3 {
  const f = FACES[face]
  const s = -1 + (2 * u + 1) / N
  const t = -1 + (2 * v + 1) / N
  return f.normal.clone()
    .addScaledVector(f.right, s)
    .addScaledVector(f.up, t)
}

// Inverse: which (face, u, v) corresponds to a given centroid.
// For N=2, after a 90° rotation the centroid still has exactly one component
// of magnitude 1; the largest |component| picks the face.
export function centroidToFaceUV(c: Vector3): { face: FaceIndex; u: number; v: number } {
  const ax = Math.abs(c.x), ay = Math.abs(c.y), az = Math.abs(c.z)
  let face: FaceIndex
  if (ax >= ay && ax >= az) face = (c.x > 0 ? 0 : 1) as FaceIndex
  else if (ay >= az) face = (c.y > 0 ? 2 : 3) as FaceIndex
  else face = (c.z > 0 ? 4 : 5) as FaceIndex

  const f = FACES[face]
  const s = c.dot(f.right)
  const t = c.dot(f.up)
  const u = Math.round((s + 1) * N / 2 - 0.5)
  const v = Math.round((t + 1) * N / 2 - 0.5)
  return { face, u, v }
}

export function tileInSlice(tile: Tile, axis: Axis, sliceIndex: number): boolean {
  const c = tileCentroid(tile.face, tile.u, tile.v)
  const comp = c[axis]
  return sliceIndex === 0 ? comp < -0.01 : comp > 0.01
}

export function rotateSlice(
  tiles: readonly Tile[],
  axis: Axis,
  sliceIndex: number,
  dir: Direction,
): Tile[] {
  const sliceQuat = new Quaternion().setFromAxisAngle(AXIS_VEC[axis], (dir * Math.PI) / 2)
  return tiles.map(t => {
    if (!tileInSlice(t, axis, sliceIndex)) return t
    const c = tileCentroid(t.face, t.u, t.v).applyQuaternion(sliceQuat)
    const dest = centroidToFaceUV(c)
    return {
      ...t,
      face: dest.face,
      u: dest.u,
      v: dest.v,
      orientation: sliceQuat.clone().multiply(t.orientation),
    }
  })
}

export interface Move {
  axis: Axis
  slice: number
  dir: Direction
}

export function inverseMove(m: Move): Move {
  return { axis: m.axis, slice: m.slice, dir: -m.dir as Direction }
}

export function randomMove(rng: () => number = Math.random, prev?: Move): Move {
  const axes: Axis[] = ['x', 'y', 'z']
  let m: Move
  do {
    m = {
      axis: axes[Math.floor(rng() * 3)],
      slice: Math.floor(rng() * N),
      dir: rng() < 0.5 ? 1 : -1,
    }
    // Avoid trivial inverse of the previous move (visual quality)
  } while (prev && m.axis === prev.axis && m.slice === prev.slice && m.dir === -prev.dir)
  return m
}
