#!/usr/bin/env node
/**
 * Generate placeholder GLB files for level slots that don't have a hand-
 * authored asset yet (issue #48 — sequential planet progression).
 *
 * Each placeholder is a minimal colored cube (~700 bytes) — enough to
 * render distinctly in /edit/levels/lvl_N/?glb=1 and the /game/ flow until
 * a real Blender-authored planet replaces it. Re-run this script to reset
 * any placeholder slot (will not overwrite lvl_1 — that's the real planet).
 *
 * Usage: node scripts/gen-placeholder-levels.mjs
 */
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

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
 * Build a minimal GLB containing a colored unit cube. Format reference:
 * https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-glb-file-format-specification
 */
function buildColoredCubeGlb([r, g, b]) {
  // Faceted cube: 24 verts (4 per face × 6 faces), 36 indices (2 tri × 6 face × 3).
  const positions = new Float32Array([
    // +X face
     1,-1, 1,  1,-1,-1,  1, 1,-1,  1, 1, 1,
    // -X face
    -1,-1,-1, -1,-1, 1, -1, 1, 1, -1, 1,-1,
    // +Y face (top)
    -1, 1, 1,  1, 1, 1,  1, 1,-1, -1, 1,-1,
    // -Y face (bottom)
    -1,-1,-1,  1,-1,-1,  1,-1, 1, -1,-1, 1,
    // +Z face
    -1,-1, 1,  1,-1, 1,  1, 1, 1, -1, 1, 1,
    // -Z face
     1,-1,-1, -1,-1,-1, -1, 1,-1,  1, 1,-1,
  ])
  const normals = new Float32Array([
     1,0,0,  1,0,0,  1,0,0,  1,0,0,
    -1,0,0, -1,0,0, -1,0,0, -1,0,0,
     0,1,0,  0,1,0,  0,1,0,  0,1,0,
     0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
     0,0,1,  0,0,1,  0,0,1,  0,0,1,
     0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
  ])
  const indices = new Uint16Array([
    0,1,2,    0,2,3,
    4,5,6,    4,6,7,
    8,9,10,   8,10,11,
    12,13,14, 12,14,15,
    16,17,18, 16,18,19,
    20,21,22, 20,22,23,
  ])

  // Pack into one binary buffer with 4-byte alignment between sub-views.
  const posBytes = positions.byteLength       // 24 * 12 = 288
  const normBytes = normals.byteLength        // 288
  const idxBytes = indices.byteLength         // 36 * 2 = 72
  const idxOffset = posBytes + normBytes      // 576
  const totalBytes = align4(idxOffset + idxBytes) // 648 (already 4-aligned, padding noop)

  const bin = Buffer.alloc(totalBytes)
  Buffer.from(positions.buffer, positions.byteOffset, posBytes).copy(bin, 0)
  Buffer.from(normals.buffer, normals.byteOffset, normBytes).copy(bin, posBytes)
  Buffer.from(indices.buffer, indices.byteOffset, idxBytes).copy(bin, idxOffset)

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
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: 0,
        roughnessFactor: 0.85,
      },
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-1,-1,-1], max: [1,1,1] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0,         byteLength: posBytes,  target: 34962 },
      { buffer: 0, byteOffset: posBytes,  byteLength: normBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes,  target: 34963 },
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
  return out
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
  const glb = buildColoredCubeGlb(color)
  writeFileSync(path, glb)
  console.log(`wrote ${path} (${glb.length} bytes, color rgb(${color.map(c => Math.round(c * 255)).join(',')}))`)
  wrote++
}
console.log(`done — ${wrote} placeholder${wrote === 1 ? '' : 's'} generated`)
