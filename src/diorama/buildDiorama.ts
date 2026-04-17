/**
 * Imperative diorama builder.
 *
 * Base: 2 wide (X: -1..+1) × 3 deep (Z: -1.5..+1.5)
 * Grid: 4 columns × 6 rows of 0.5×0.5 square cells = 24 tiles.
 * Each cube face = 2×2 cells = 1×1 unit (square).
 */

import * as THREE from 'three'

export const BASE_W = 4   // X extent (4 columns × 1 unit)
export const BASE_H = 6   // Z extent (6 rows × 1 unit)
export const HALF_W = BASE_W / 2  // 2
export const HALF_H = BASE_H / 2  // 3

// ── helpers ──────────────────────────────────────────────────────────

function mat(opts: THREE.MeshStandardMaterialParameters) {
  return new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...opts })
}

function pseudoNoise(x: number, z: number) {
  // Halve frequency so hills stay same visual scale at 2× base
  return (
    Math.sin(x * 1.85 + 0.3) * Math.cos(z * 1.45 + 1.1) * 0.12 +
    Math.sin(x * 3.55 + z * 2.65) * 0.05
  )
}

// ── terrain ──────────────────────────────────────────────────────────

function buildTerrain(): THREE.Mesh {
  const segX = 32
  const segZ = 48 // more segments for the longer axis
  const g = new THREE.PlaneGeometry(BASE_W, BASE_H, segX, segZ)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const rawH = pseudoNoise(x, z)
    pos.setY(i, 0) // flat terrain
    const g1 = 0.38 + rawH * 2.5 + Math.sin(x * 11 + z * 7) * 0.06 // color still varies (dark in low areas)
    colors[i * 3] = 0.28 + Math.sin(x * 5) * 0.04
    colors[i * 3 + 1] = g1
    colors[i * 3 + 2] = 0.12
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()
  const m = new THREE.Mesh(g, mat({ vertexColors: true, roughness: 0.85 }))
  m.receiveShadow = true
  m.name = 'terrain'
  return m
}

// ── water (animated) ─────────────────────────────────────────────────

function buildPond(cx: number, cz: number, radius: number, name: string) {
  // Use a subdivided plane clipped to a circle for enough vertices
  // to curve correctly under sphere projection
  const seg = 32
  const g = new THREE.PlaneGeometry(radius * 2, radius * 2, seg, seg)
  g.rotateX(-Math.PI / 2)
  // Clip vertices to circle and store original Y
  const pos = g.attributes.position
  const origY = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const dist = Math.sqrt(x * x + z * z)
    if (dist > radius) {
      // Move vertex to circle edge to avoid rendering outside
      const scale = radius / dist
      pos.setX(i, x * scale)
      pos.setZ(i, z * scale)
    }
  }
  pos.needsUpdate = true
  const m = new THREE.Mesh(
    g,
    mat({ color: '#3a7db8', transparent: true, opacity: 0.75, roughness: 0.15, metalness: 0.3 }),
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

const TREE_POSITIONS: [number, number, number][] = [
  // Original region (Z: -2 to +2 area)
  [-0.5, 0, 1.1], [0.3, 0, 1.2], [-1.3, 0, 0.9],
  [-1.4, 0, -1.3], [0.6, 0, -1.2], [-0.3, 0, -1.4], [1.4, 0, 0.3],
  // Extended region (Z: -2 to -3)
  [-1.2, 0, -2.3], [0.2, 0, -2.6], [1.3, 0, -2.2],
  [-0.6, 0, -2.8], [0.9, 0, -2.7],
]
const TREE_SCALES = [1, 0.75, 0.9, 1.1, 0.65, 0.85, 0.7, 0.8, 0.95, 0.7, 1.05, 0.6]

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
  const g = new THREE.Group()
  g.name = 'fence'
  for (let i = 0; i < 6; i++) {
    const t = i / 5
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.12, 0.03),
      mat({ color: '#7a6040', roughness: 0.9 }),
    )
    post.position.set(
      THREE.MathUtils.lerp(-0.7, 0.8, t),
      0.06,
      THREE.MathUtils.lerp(-0.6, -0.9, t),
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

  // Original region (scaled 2×)
  for (let i = 0; i < 18; i++) {
    const a = i * 2.399
    const r = 0.4 + (i / 18) * 1.2
    const x = Math.cos(a) * r * 0.9
    const z = Math.sin(a) * r * 0.85
    if (Math.sqrt((x - 0.9) ** 2 + (z - 0.6) ** 2) < 0.76) continue
    if (Math.sqrt((x + 1.0) ** 2 + (z + 0.7) ** 2) < 0.4) continue
    const flower = new THREE.Mesh(
      new THREE.SphereGeometry(0.024, 5, 4),
      mat({ color: colors[ci++ % colors.length], roughness: 0.6 }),
    )
    flower.position.set(x, 0.04, z)
    g.add(flower)
  }

  // Extended region flowers
  for (let i = 0; i < 10; i++) {
    const a = i * 2.399 + 1.0
    const r = 0.3 + (i / 10) * 1.0
    const x = Math.cos(a) * r * 0.85
    const z = -2.0 + Math.sin(a) * r * 0.8 - 0.4
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
  const g = new THREE.Group()
  g.name = 'stonepath'
  for (let i = 0; i < 8; i++) {
    const t = i / 7
    const r = 0.04 + Math.sin(i * 4.1) * 0.016
    const stone = new THREE.Mesh(
      new THREE.CircleGeometry(r, 6),
      mat({ color: '#8a8070', roughness: 0.95 }),
    )
    stone.position.set(
      THREE.MathUtils.lerp(-1.0, -0.2, t) + Math.sin(i * 2.3) * 0.06,
      0.01,
      THREE.MathUtils.lerp(-0.44, 0.3, t) + Math.cos(i * 1.7) * 0.06,
    )
    stone.rotation.x = -Math.PI / 2
    stone.rotation.z = i * 1.1
    g.add(stone)
  }
  return g
}

// ── well (new structure for extended area) ───────────────────────────

function buildWell(): THREE.Group {
  const g = new THREE.Group()
  g.position.set(1.0, 0, -2.4)
  g.name = 'well'

  // Stone base (cylinder)
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 0.24, 8),
    mat({ color: '#8a8070', roughness: 0.95 }),
  )
  base.position.y = 0.12; base.castShadow = true
  g.add(base)

  // Roof supports (two posts)
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.4, 4),
      mat({ color: '#6b4c30', roughness: 0.9 }),
    )
    post.position.set(side * 0.14, 0.44, 0)
    post.castShadow = true
    g.add(post)
  }

  // Small roof
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.12, 4),
    mat({ color: '#8b4a2a', roughness: 0.8 }),
  )
  roof.position.y = 0.7; roof.rotation.y = Math.PI / 4
  roof.castShadow = true
  g.add(roof)

  return g
}

// ── rocks (extended area detail) ─────────────────────────────────────

function buildRocks(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'rocks'
  const rockPositions: [number, number, number, number][] = [
    [-1.5, 0.06, -2.1, 0.12],
    [-1.7, 0.04, -2.5, 0.08],
    [1.6, 0.05, -2.7, 0.1],
    [-0.4, 0.04, -2.9, 0.07],
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

// ── base boundary ────────────────────────────────────────────────────

function buildBase(): THREE.Mesh {
  // Subdivided plane so it curves correctly under sphere projection
  const g = new THREE.PlaneGeometry(BASE_W, BASE_H, 32, 48)
  g.rotateX(-Math.PI / 2)
  const m = new THREE.Mesh(g, mat({ color: '#3a2a1a', roughness: 1 }))
  m.position.y = -0.001 // just below terrain to avoid z-fighting
  m.name = 'base'
  return m
}

// ── compose ──────────────────────────────────────────────────────────

export interface DioramaScene {
  root: THREE.Group
  update: (elapsed: number) => void
}

export function buildDiorama(): DioramaScene {
  const root = new THREE.Group()
  root.name = 'diorama'

  // Water: original pond + a stream in the extended area
  const pond = buildPond(0.9, 0.6, 0.64, 'pond')
  const stream = buildPond(-0.2, -2.4, 0.4, 'stream')

  const windmill = buildWindmill(1.1, -1.0)
  const trees = buildTrees()
  const smoke = buildSmoke(-1.0, -0.7)

  root.add(buildBase())
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
