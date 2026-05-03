#!/usr/bin/env node
/**
 * Generate placeholder GLB files for level slots that don't have a hand-
 * authored asset yet (issue #48 — sequential planet progression).
 *
 * Each placeholder is a colored CROSS CUBE-NET — the same 8×6 cell layout
 * that buildDiorama produces in code (see src/diorama/buildDiorama.ts header
 * for the cell map). The mesh is a single subdivided plane named "terrain"
 * in the XZ plane (Y=0), so the dev playground's four preview modes all
 * have something to render against:
 *
 *   - grid  → flat top-down cube-net
 *   - split → 6 face-blocks separated
 *   - cube  → 6 blocks wrapped into a cube
 *   - rubik → cube-net wrapped into a sphere
 *
 * Subdivisions per face block: 8×8 (≈4/cell) — meets the sphere-projection
 * minimum (per memory: long-span meshes chord through the sphere when
 * widthSegments < 8/face). Output is ~20 KB per slot — small enough to
 * commit, plenty to edit against in Blender.
 *
 * Usage: node scripts/gen-placeholder-levels.mjs
 */
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Cross cube-net face blocks (mirror of src/diorama/buildDiorama.ts header).
// Each block is a 2×2 area in (x, z); subdivided uniformly. Block order
// doesn't matter — every block becomes its own contiguous slice of the
// vertex/index buffer.
const FACE_BLOCKS = [
  { name: 'B', x0: -4, z0: -1, w: 2, h: 2 }, // -X left
  { name: 'E', x0: -2, z0: -1, w: 2, h: 2 }, // +Z center
  { name: 'A', x0:  0, z0: -1, w: 2, h: 2 }, // +X right
  { name: 'F', x0:  2, z0: -1, w: 2, h: 2 }, // -Z far right
  { name: 'C', x0: -2, z0:  1, w: 2, h: 2 }, // +Y top
  { name: 'D', x0: -2, z0: -3, w: 2, h: 2 }, // -Y bottom
]
const SUB = 8 // segments per face block (4 per cell)

// Slug → linear-RGB color in [0,1]. Tints chosen for distinct hue spacing
// against country-land's warm-meadow palette so the editor can tell them
// apart at a glance.
const PLACEHOLDERS = [
  { slug: 'lvl_2', color: [0.78, 0.34, 0.26] },  // terracotta
  { slug: 'lvl_3', color: [0.42, 0.62, 0.34] },  // sage
  { slug: 'lvl_4', color: [0.32, 0.52, 0.78] },  // dusty blue
  { slug: 'lvl_5', color: [0.62, 0.42, 0.78] },  // lavender
]

/**
 * Build cross cube-net geometry as flat Float32/Uint16 arrays. Each block
 * gets its own (SUB+1)² vertex grid; blocks don't share verts even where
 * they touch in the cross layout (matches the country-land pipeline, which
 * welds seams at load time via weldSeams).
 */
function buildCrossCubeNet() {
  const positions = []
  const normals = []
  const indices = []
  for (const blk of FACE_BLOCKS) {
    const baseIdx = positions.length / 3
    const stepX = blk.w / SUB
    const stepZ = blk.h / SUB
    for (let j = 0; j <= SUB; j++) {
      for (let i = 0; i <= SUB; i++) {
        const x = blk.x0 + i * stepX
        const z = blk.z0 + j * stepZ
        positions.push(x, 0, z)
        normals.push(0, 1, 0)
      }
    }
    for (let j = 0; j < SUB; j++) {
      for (let i = 0; i < SUB; i++) {
        const a = baseIdx + j * (SUB + 1) + i
        const b = a + 1
        const c = a + (SUB + 1)
        const d = c + 1
        indices.push(a, c, b,  b, c, d)
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    normals:   new Float32Array(normals),
    indices:   new Uint16Array(indices),
  }
}

/**
 * Pack the cross cube-net + a colored material into a minimal GLB.
 * Format reference:
 * https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-glb-file-format-specification
 */
function buildPlaceholderGlb([r, g, b]) {
  const { positions, normals, indices } = buildCrossCubeNet()
  const vertCount = positions.length / 3
  const triCount = indices.length / 3
  const posBytes = positions.byteLength
  const normBytes = normals.byteLength
  // Pad indices section to a 4-byte boundary so the next view (none here,
  // but keep the discipline) starts aligned.
  const idxBytes = indices.byteLength
  const idxOffset = align4(posBytes + normBytes)
  const totalBytes = align4(idxOffset + idxBytes)

  const bin = Buffer.alloc(totalBytes)
  Buffer.from(positions.buffer, positions.byteOffset, posBytes).copy(bin, 0)
  Buffer.from(normals.buffer, normals.byteOffset, normBytes).copy(bin, posBytes)
  Buffer.from(indices.buffer, indices.byteOffset, idxBytes).copy(bin, idxOffset)

  // Position min/max for accessor metadata (loaders use this for bounds /
  // frustum culling; required by spec for POSITION accessors).
  let xmin = Infinity, ymin = Infinity, zmin = Infinity
  let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity
  for (let i = 0; i < vertCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < xmin) xmin = x; if (x > xmax) xmax = x
    if (y < ymin) ymin = y; if (y > ymax) ymax = y
    if (z < zmin) zmin = z; if (z > zmax) zmax = z
  }

  const gltf = {
    asset: { version: '2.0', generator: 'rubicsworld-placeholder-gen' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    // Mesh named 'terrain' so loadGlbDiorama's normal-recompute pass picks
    // it up (matches 'terrain'/'ground' name prefix convention).
    nodes: [{ mesh: 0, name: 'terrain' }],
    meshes: [{
      name: 'terrain',
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        indices: 2,
        material: 0,
      }],
    }],
    materials: [{
      name: 'placeholder',
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: 0,
        roughnessFactor: 0.85,
      },
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertCount, type: 'VEC3', min: [xmin, ymin, zmin], max: [xmax, ymax, zmax] },
      { bufferView: 1, componentType: 5126, count: vertCount, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: triCount * 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0,                  byteLength: posBytes,  target: 34962 },
      { buffer: 0, byteOffset: posBytes,           byteLength: normBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset,          byteLength: idxBytes,  target: 34963 },
    ],
    buffers: [{ byteLength: totalBytes }],
  }

  // GLB chunks must be 4-byte aligned. JSON pads with spaces (0x20), BIN
  // pads with zeros — both per spec.
  const jsonText = JSON.stringify(gltf)
  const jsonBytes = Buffer.from(jsonText, 'utf-8')
  const jsonPadded = padTo4(jsonBytes, 0x20)
  const binPadded = padTo4(bin, 0x00)

  const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length
  const out = Buffer.alloc(totalLength)
  let p = 0
  // Header
  out.writeUInt32LE(0x46546C67, p); p += 4 // 'glTF'
  out.writeUInt32LE(2, p); p += 4
  out.writeUInt32LE(totalLength, p); p += 4
  // JSON chunk
  out.writeUInt32LE(jsonPadded.length, p); p += 4
  out.writeUInt32LE(0x4E4F534A, p); p += 4 // 'JSON'
  jsonPadded.copy(out, p); p += jsonPadded.length
  // BIN chunk
  out.writeUInt32LE(binPadded.length, p); p += 4
  out.writeUInt32LE(0x004E4942, p); p += 4 // 'BIN\0'
  binPadded.copy(out, p)
  return { glb: out, vertCount, triCount }
}

function align4(n) { return (n + 3) & ~3 }
function padTo4(buf, fillByte) {
  const padded = align4(buf.length)
  if (padded === buf.length) return buf
  const out = Buffer.alloc(padded, fillByte)
  buf.copy(out, 0)
  return out
}

let wrote = 0
for (const { slug, color } of PLACEHOLDERS) {
  const dir = resolve(ROOT, 'public', 'levels', slug)
  const path = resolve(dir, 'diorama.glb')
  mkdirSync(dir, { recursive: true })
  const { glb, vertCount, triCount } = buildPlaceholderGlb(color)
  writeFileSync(path, glb)
  console.log(
    `wrote ${path} (${glb.length} bytes, ${vertCount} verts, ${triCount} tris,` +
    ` color rgb(${color.map(c => Math.round(c * 255)).join(',')}))`,
  )
  wrote++
}
console.log(`done — ${wrote} placeholder${wrote === 1 ? '' : 's'} generated`)
