/**
 * Imperative diorama builder on the cross cube-net layout.
 *
 * Bounding box: 8 × 6 cells (cross net). Only 24 cells are "filled" —
 * the rest is empty padding in the flat view but unreachable during
 * sphere/cube rendering (each face-block maps to one cube face).
 *
 * Face-block local extents in (x, z):
 *   E (+Z center):      x ∈ [-2,  0], z ∈ [-1,  1]
 *   A (+X right):       x ∈ [ 0,  2], z ∈ [-1,  1]
 *   B (-X left):        x ∈ [-4, -2], z ∈ [-1,  1]
 *   F (-Z far right):   x ∈ [ 2,  4], z ∈ [-1,  1]
 *   C (+Y top):         x ∈ [-2,  0], z ∈ [ 1,  3]
 *   D (-Y bottom):      x ∈ [-2,  0], z ∈ [-3, -1]
 *
 * Every object is placed strictly inside one face-block, so nothing
 * gets cut across a flat-adjacent seam that would land on a mismatched
 * cube edge.
 */

import * as THREE from 'three'

export const BASE_W = 8
export const BASE_H = 6
export const HALF_W = BASE_W / 2  // 4
export const HALF_H = BASE_H / 2  // 3

// ── helpers ──────────────────────────────────────────────────────────

function mat(opts: THREE.MeshStandardMaterialParameters) {
  return new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...opts })
}

function pseudoNoise(x: number, z: number) {
  return (
    Math.sin(x * 1.85 + 0.3) * Math.cos(z * 1.45 + 1.1) * 0.12 +
    Math.sin(x * 3.55 + z * 2.65) * 0.05
  )
}

/** Cross-net membership test (keeps the terrain / fills in the net shape). */
function onNet(x: number, z: number): boolean {
  // Middle band: x ∈ [-4, 4], z ∈ [-1, 1]
  if (z >= -1 && z <= 1) return x >= -4 && x <= 4
  // C (top) or D (bottom) stems: x ∈ [-2, 0]
  if (x >= -2 && x <= 0) return z >= -3 && z <= 3
  return false
}

// ── terrain ──────────────────────────────────────────────────────────

/**
 * Procedurally builds a tileable grass-like texture. Uses only periodic
 * (sin/cos) functions of the normalized pixel coordinates so the pattern
 * wraps perfectly at u=0↔1 and v=0↔1 — no visible seam when UVs cross a
 * texture-unit boundary.
 */
function createGrassTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')

  const img = ctx.createImageData(size, size)
  const TAU = Math.PI * 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      // Periodic multi-octave variation (all frequencies integer → tileable).
      const a = Math.sin(u * TAU * 7) * Math.cos(v * TAU * 9)
      const b = Math.sin(u * TAU * 17 + v * TAU * 11)
      const c = Math.sin(u * TAU * 3 + v * TAU * 5) * 0.6
      const d = Math.sin((u + v) * TAU * 23) * 0.35
      const n = a * 0.5 + b * 0.25 + c * 0.25 + d * 0.2

      // Green base with gold/olive highlights and darker valley patches.
      const bright = 0.55 + n * 0.2
      const r = 0.28 + 0.18 * Math.max(0, n) + 0.05 * Math.sin(u * TAU * 13)
      const g = 0.48 + 0.28 * bright
      const bch = 0.18 + 0.08 * bright

      const idx = (y * size + x) * 4
      img.data[idx]     = Math.min(255, Math.max(0, r * 255))
      img.data[idx + 1] = Math.min(255, Math.max(0, g * 255))
      img.data[idx + 2] = Math.min(255, Math.max(0, bch * 255))
      img.data[idx + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

// Module-scoped cache — one texture instance shared across every buildDiorama
// call (24 per frame in sphere render) avoids re-generating 64KB of pixel data
// each time.
let _grassTex: THREE.CanvasTexture | null = null
function grassTexture(): THREE.CanvasTexture {
  if (!_grassTex) _grassTex = createGrassTexture(256)
  return _grassTex
}

function buildTerrain(): THREE.Mesh {
  const segX = 64
  const segZ = 48
  const g = new THREE.PlaneGeometry(BASE_W, BASE_H, segX, segZ)
  g.rotateX(-Math.PI / 2)

  const pos = g.attributes.position
  const uv = g.attributes.uv
  const colors = new Float32Array(pos.count * 3)

  // UV tile density: one texture repeat per face-block (2 world units).
  // Because the cross-net layout guarantees flat-adjacent cells map to
  // cube-adjacent cells, and the texture wraps at integer UV boundaries,
  // the grass flows continuously across every cube face seam.
  const UV_DENSITY = 0.5  // 0.5 repeats per world unit → 1 repeat per face-block

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    pos.setY(i, 0)

    // World-space UVs. Adjacent face-blocks share texel-accurate edges.
    uv.setXY(i, x * UV_DENSITY, z * UV_DENSITY)

    // Vertex colour still provides per-cell variation and dims the padding
    // so the cross shape reads in grid view. Combined with the map it gives
    // subtle hue variation on top of the grass.
    const rawH = pseudoNoise(x, z)
    const dim = onNet(x, z) ? 1 : 0.35
    const tint = 0.9 + rawH * 0.8 + Math.sin(x * 11 + z * 7) * 0.05
    colors[i * 3]     = (0.95 + Math.sin(x * 5) * 0.05) * dim
    colors[i * 3 + 1] = tint * dim
    colors[i * 3 + 2] = 0.85 * dim
  }

  uv.needsUpdate = true
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()

  const m = new THREE.Mesh(g, mat({
    vertexColors: true,
    map: grassTexture(),
    roughness: 0.9,
  }))
  m.receiveShadow = true
  m.name = 'terrain'
  return m
}

// ── water (animated) ─────────────────────────────────────────────────

function buildPond(cx: number, cz: number, radius: number, name: string) {
  const seg = 32
  const g = new THREE.PlaneGeometry(radius * 2, radius * 2, seg, seg)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  const origY = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const dist = Math.sqrt(x * x + z * z)
    if (dist > radius) {
      const scale = radius / dist
      pos.setX(i, x * scale)
      pos.setZ(i, z * scale)
    }
  }
  pos.needsUpdate = true
  const m = new THREE.Mesh(
    g,
    mat({ color: '#3a7db8', transparent: true, opacity: 0.8, roughness: 0.15, metalness: 0.3 }),
  )
  m.position.set(cx, 0.05, cz)
  m.receiveShadow = true
  m.name = name

  const update = (t: number) => {
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, origY[i] + Math.sin(x * 8 + t * 2.5) * 0.008 + Math.cos(z * 6 + t * 1.8) * 0.006)
    }
    pos.needsUpdate = true
  }

  return { mesh: m, update }
}

// ── hut ──────────────────────────────────────────────────────────────

function buildHut(px: number, pz: number): THREE.Group {
  const g = new THREE.Group()
  g.position.set(px, 0, pz)
  g.name = 'hut'

  const walls = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.4, 0.44), mat({ color: '#c4a67a', roughness: 0.9 }))
  walls.position.set(0, 0.2, 0); walls.castShadow = true; walls.receiveShadow = true
  g.add(walls)

  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.44, 0.28, 4), mat({ color: '#8b4a2a', roughness: 0.8 }))
  roof.position.set(0, 0.52, 0); roof.rotation.y = Math.PI / 4; roof.castShadow = true
  g.add(roof)

  const door = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.02), mat({ color: '#5a3a1a' }))
  door.position.set(0, 0.12, 0.224)
  g.add(door)

  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), mat({ color: '#7a6a5a' }))
  chimney.position.set(0.16, 0.6, -0.08); chimney.castShadow = true
  g.add(chimney)

  return g
}

// ── windmill (animated) ──────────────────────────────────────────────

function buildWindmill(px: number, pz: number) {
  const g = new THREE.Group()
  g.position.set(px, 0, pz)
  g.name = 'windmill'

  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.8, 8), mat({ color: '#9a9080', roughness: 0.9 }))
  tower.position.set(0, 0.4, 0); tower.castShadow = true
  g.add(tower)

  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.12, 8), mat({ color: '#6a5a4a' }))
  cap.position.set(0, 0.84, 0); cap.castShadow = true
  g.add(cap)

  const blades = new THREE.Group()
  blades.position.set(0, 0.7, 0.14)
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.44, 0.01), mat({ color: '#d4c8a0', roughness: 0.7 }))
    blade.rotation.z = (i * Math.PI) / 2
    blade.castShadow = true
    blades.add(blade)
  }
  g.add(blades)

  const update = (t: number) => { blades.rotation.z = t * 0.8 }

  return { group: g, update }
}

// ── trees (animated sway) ────────────────────────────────────────────

// Trees inside face-blocks only. Each tree sits strictly within one block
// so no tree mesh straddles a flat seam (which would fold poorly).
const TREE_POSITIONS: [number, number, number][] = [
  // E block  (x ∈ [-2, 0], z ∈ [-1, 1])
  [-1.7,  0, -0.7],
  [-0.3,  0,  0.7],
  // A block  (x ∈ [0, 2], z ∈ [-1, 1])
  [ 0.3,  0, -0.7],
  [ 1.8,  0,  0.6],
  // B block  (x ∈ [-4, -2], z ∈ [-1, 1])
  [-2.3,  0,  0.5],
  [-3.5,  0, -0.5],
  [-2.9,  0,  0.8],
  // F block  (x ∈ [2, 4], z ∈ [-1, 1])
  [ 2.3,  0, -0.6],
  [ 3.6,  0,  0.4],
  // C block  (x ∈ [-2, 0], z ∈ [1, 3])  — top face
  [-1.6,  0,  1.4],
  [-0.4,  0,  2.4],
  // D block  (x ∈ [-2, 0], z ∈ [-3, -1])  — bottom face
  [-0.6,  0, -1.5],
  [-1.7,  0, -2.4],
]
const TREE_SCALES = [
  1.0, 0.85,   // E
  0.9, 1.05,   // A
  0.75, 0.65, 0.9, // B
  0.8, 0.95,   // F
  0.7, 0.8,    // C
  1.0, 0.75,   // D
]

function buildTrees() {
  const root = new THREE.Group()
  root.name = 'trees'
  const swayGroups: { g: THREE.Group; phase: number }[] = []

  for (let i = 0; i < TREE_POSITIONS.length; i++) {
    const pos = TREE_POSITIONS[i]
    const s = TREE_SCALES[i]
    const phase = i * 2.1

    const tree = new THREE.Group()
    tree.position.set(...pos)

    const swayG = new THREE.Group()
    const trunkH = 0.36 * s
    const canopyR = 0.2 * s

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03 * s, 0.05 * s, trunkH, 6),
      mat({ color: '#6b4c30', roughness: 0.9 }),
    )
    trunk.position.y = trunkH / 2; trunk.castShadow = true
    swayG.add(trunk)

    const canopy = new THREE.Mesh(
      new THREE.IcosahedronGeometry(canopyR, 1),
      mat({ color: s > 0.9 ? '#3a7a3a' : '#4a8a3a', roughness: 0.8 }),
    )
    canopy.position.y = trunkH + canopyR * 0.6; canopy.castShadow = true
    swayG.add(canopy)

    tree.add(swayG)
    root.add(tree)
    swayGroups.push({ g: swayG, phase })
  }

  const update = (t: number) => {
    for (const { g, phase } of swayGroups) {
      g.rotation.z = Math.sin(t * 1.2 + phase) * 0.03
      g.rotation.x = Math.cos(t * 0.9 + phase * 1.3) * 0.02
    }
  }

  return { group: root, update }
}

// ── fence ────────────────────────────────────────────────────────────

function buildFence(): THREE.Group {
  // Inside E block only. Cosmetic front-yard boundary.
  const g = new THREE.Group()
  g.name = 'fence'
  for (let i = 0; i < 5; i++) {
    const t = i / 4
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.12, 0.03),
      mat({ color: '#7a6040', roughness: 0.9 }),
    )
    post.position.set(
      THREE.MathUtils.lerp(-1.6, -0.4, t),
      0.06,
      THREE.MathUtils.lerp(0.7, 0.9, t),
    )
    post.castShadow = true
    g.add(post)
  }
  return g
}

// ── flowers ──────────────────────────────────────────────────────────

function buildFlowers(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'flowers'
  const colors = ['#e85a7a', '#e8c85a', '#fff', '#d07ae8', '#e8a05a']
  let ci = 0

  // Flowers within face blocks. Positions hand-picked so each block has a few.
  const spots: [number, number][] = [
    // E block
    [-0.5, -0.2], [-1.3, -0.5], [-0.8, 0.4],
    // A block
    [ 0.6,  0.3], [ 1.4, -0.5], [ 0.8, -0.2],
    // B block
    [-2.4, -0.3], [-3.1,  0.2], [-3.6, -0.7],
    // F block
    [ 2.5,  0.2], [ 3.2, -0.4], [ 3.7,  0.6],
    // C block (top)
    [-1.4,  1.6], [-0.7,  2.7],
    // D block (bottom)
    [-1.4, -1.6], [-0.7, -2.7],
  ]
  for (const [x, z] of spots) {
    const flower = new THREE.Mesh(
      new THREE.SphereGeometry(0.024, 5, 4),
      mat({ color: colors[ci++ % colors.length], roughness: 0.6 }),
    )
    flower.position.set(x, 0.04, z)
    g.add(flower)
  }

  return g
}

// ── smoke (animated) ─────────────────────────────────────────────────

function buildSmoke(px: number, pz: number) {
  const g = new THREE.Group()
  g.position.set(px + 0.16, 0.72, pz - 0.08)
  g.name = 'smoke'

  const particles: { offset: number; xBase: number; mat: THREE.MeshStandardMaterial }[] = []
  for (let i = 0; i < 5; i++) {
    const m = new THREE.MeshStandardMaterial({
      color: '#c8c0b0', transparent: true, opacity: 0.3, depthWrite: false,
    })
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 6), m)
    mesh.scale.setScalar(0.016)
    g.add(mesh)
    particles.push({ offset: i * 0.4, xBase: Math.sin(i * 3.7) * 0.02, mat: m })
  }

  const update = (t: number) => {
    g.children.forEach((child, i) => {
      const p = particles[i]
      const age = ((t + p.offset) % 2) / 2
      child.position.y = age * 0.3
      child.position.x = p.xBase + Math.sin(t * 0.5 + i) * 0.02
      child.scale.setScalar(0.016 + age * 0.03)
      p.mat.opacity = 0.35 * (1 - age)
    })
  }

  return { group: g, update }
}

// ── stone path ───────────────────────────────────────────────────────

function buildStonePath(): THREE.Group {
  // Path inside E block leading to hut.
  const g = new THREE.Group()
  g.name = 'stonepath'
  for (let i = 0; i < 6; i++) {
    const t = i / 5
    const r = 0.04 + Math.sin(i * 4.1) * 0.016
    const stone = new THREE.Mesh(
      new THREE.CircleGeometry(r, 6),
      mat({ color: '#8a8070', roughness: 0.95 }),
    )
    stone.position.set(
      THREE.MathUtils.lerp(-0.1, -0.9, t) + Math.sin(i * 2.3) * 0.05,
      0.01,
      THREE.MathUtils.lerp(0.8, -0.3, t) + Math.cos(i * 1.7) * 0.05,
    )
    stone.rotation.x = -Math.PI / 2
    stone.rotation.z = i * 1.1
    g.add(stone)
  }
  return g
}

// ── well (F block) ───────────────────────────────────────────────────

function buildWell(): THREE.Group {
  const g = new THREE.Group()
  g.position.set(3.0, 0, -0.1)
  g.name = 'well'

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 0.24, 8),
    mat({ color: '#8a8070', roughness: 0.95 }),
  )
  base.position.y = 0.12; base.castShadow = true
  g.add(base)

  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.4, 4),
      mat({ color: '#6b4c30', roughness: 0.9 }),
    )
    post.position.set(side * 0.14, 0.44, 0)
    post.castShadow = true
    g.add(post)
  }

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.12, 4),
    mat({ color: '#8b4a2a', roughness: 0.8 }),
  )
  roof.position.y = 0.7; roof.rotation.y = Math.PI / 4
  roof.castShadow = true
  g.add(roof)

  return g
}

// ── rocks (B block detail) ───────────────────────────────────────────

function buildRocks(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'rocks'
  const rockPositions: [number, number, number, number][] = [
    [-2.5, 0.06,  0.3, 0.12],
    [-3.3, 0.04, -0.2, 0.08],
    [-3.8, 0.05,  0.5, 0.10],
    [-2.7, 0.04, -0.7, 0.07],
  ]
  for (const [x, y, z, r] of rockPositions) {
    const rock = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r, 0),
      mat({ color: '#7a7060', roughness: 0.95 }),
    )
    rock.position.set(x, y, z)
    rock.rotation.set(x * 3, z * 2, x + z)
    rock.castShadow = true
    g.add(rock)
  }
  return g
}

// ── compose ──────────────────────────────────────────────────────────

export interface DioramaScene {
  root: THREE.Group
  update: (elapsed: number) => void
}

export function buildDiorama(): DioramaScene {
  const root = new THREE.Group()
  root.name = 'diorama'

  // Central pond on +Y (top face): the world has a lake on top when folded.
  const pond = buildPond(-1.0, 2.0, 0.6, 'pond')
  // Stream on -Y (bottom): smaller reflective patch.
  const stream = buildPond(-1.2, -2.1, 0.45, 'stream')

  // Windmill on +X face (A). Well inside the A block; no seam crossing.
  const windmill = buildWindmill(1.0, 0.0)
  const trees = buildTrees()
  // Chimney smoke from the hut on E.
  const smoke = buildSmoke(-1.0, -0.7)

  root.add(buildTerrain())
  root.add(pond.mesh)
  root.add(stream.mesh)
  root.add(buildHut(-1.0, -0.7))
  root.add(windmill.group)
  root.add(trees.group)
  root.add(buildFence())
  root.add(buildFlowers())
  root.add(buildStonePath())
  root.add(smoke.group)
  root.add(buildWell())
  root.add(buildRocks())

  const update = (t: number) => {
    pond.update(t)
    stream.update(t)
    windmill.update(t)
    trees.update(t)
    smoke.update(t)
  }

  return { root, update }
}
