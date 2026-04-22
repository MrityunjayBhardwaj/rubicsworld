import { BufferGeometry, BufferAttribute, Vector3 } from 'three'
import { FACES, type FaceDef } from './faces'
import { N } from './tile'

const SEG = 8       // subdivisions per tile edge (smoothness of curvature)
const GAP = 0       // inset on each tile edge — 0 so tiles meet, no background showing through as "border lines"
const RADIUS = 1
const UV_REPEAT = 2 // grass texture repeats per tile when "Rubik: grass" is on

function buildOne(face: FaceDef, u: number, v: number): BufferGeometry {
  const sMin = -1 + (2 * u) / N + GAP
  const sMax = -1 + (2 * (u + 1)) / N - GAP
  const tMin = -1 + (2 * v) / N + GAP
  const tMax = -1 + (2 * (v + 1)) / N - GAP

  const cols = SEG + 1
  const verts = cols * cols
  const positions = new Float32Array(verts * 3)
  const normals = new Float32Array(verts * 3)
  const uvs = new Float32Array(verts * 2)
  const indices = new Uint16Array(SEG * SEG * 6)

  const p = new Vector3()
  let pi = 0
  for (let i = 0; i <= SEG; i++) {
    for (let j = 0; j <= SEG; j++) {
      const s = sMin + (sMax - sMin) * (i / SEG)
      const t = tMin + (tMax - tMin) * (j / SEG)
      p.copy(face.normal)
        .addScaledVector(face.right, s)
        .addScaledVector(face.up, t)
        .normalize()
      const off = (pi++) * 3
      positions[off] = p.x * RADIUS
      positions[off + 1] = p.y * RADIUS
      positions[off + 2] = p.z * RADIUS
      normals[off] = p.x
      normals[off + 1] = p.y
      normals[off + 2] = p.z
      // UV: per-tile [0, UV_REPEAT] → tiles a tight grass pattern when a map
      // is bound. Texture is RepeatWrapping so UV > 1 tiles correctly.
      const uoff = (off / 3) * 2
      uvs[uoff]     = (j / SEG) * UV_REPEAT
      uvs[uoff + 1] = (i / SEG) * UV_REPEAT
    }
  }

  let ii = 0
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * cols + j
      const b = a + 1
      const c = a + cols
      const d = c + 1
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d
    }
  }

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(positions, 3))
  g.setAttribute('normal', new BufferAttribute(normals, 3))
  g.setAttribute('uv', new BufferAttribute(uvs, 2))
  g.setIndex(new BufferAttribute(indices, 1))
  return g
}

export interface TileMeshDef {
  faceIndex: number
  u: number
  v: number
  geometry: BufferGeometry
  color: string
}

export function buildAllTileGeometries(): TileMeshDef[] {
  const out: TileMeshDef[] = []
  for (const f of FACES) {
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        out.push({ faceIndex: f.index, u, v, geometry: buildOne(f, u, v), color: f.color })
      }
    }
  }
  return out
}
