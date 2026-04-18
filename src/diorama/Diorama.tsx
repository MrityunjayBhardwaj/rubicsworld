import { useRef, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

// ── Diorama base dimensions ────────────────────────────────────────
// 2×2 square base (matches cube face span: -1..+1 on two axes).
// Height (Y) determined by tallest element.
const BASE = 2

// ── Terrain ────────────────────────────────────────────────────────
// Flat-ish ground with gentle procedural hills. Vertex colors for
// grass variation.

function pseudoNoise(x: number, z: number): number {
  return (
    Math.sin(x * 3.7 + 0.3) * Math.cos(z * 2.9 + 1.1) * 0.06 +
    Math.sin(x * 7.1 + z * 5.3) * 0.025
  )
}

export function Terrain() {
  const geo = useMemo(() => {
    const seg = 32
    const g = new THREE.PlaneGeometry(BASE, BASE, seg, seg)
    g.rotateX(-Math.PI / 2)
    const pos = g.attributes.position
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const h = pseudoNoise(x, z)
      pos.setY(i, h)
      // grass color variation
      const g1 = 0.38 + h * 2.5 + Math.sin(x * 11 + z * 7) * 0.06
      colors[i * 3] = 0.28 + Math.sin(x * 5) * 0.04 // r
      colors[i * 3 + 1] = g1                          // g
      colors[i * 3 + 2] = 0.12                        // b
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeVertexNormals()
    return g
  }, [])

  return (
    <mesh geometry={geo} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.85} />
    </mesh>
  )
}

// ── Water ──────────────────────────────────────────────────────────
// Small pond, animated vertex wave.

export function Water() {
  const ref = useRef<THREE.Mesh>(null)
  const geo = useMemo(() => {
    const g = new THREE.CircleGeometry(0.32, 24, 0, Math.PI * 2)
    g.rotateX(-Math.PI / 2)
    return g
  }, [])

  useFrame(({ clock }) => {
    const mesh = ref.current
    if (!mesh) return
    const pos = (mesh.geometry as THREE.BufferGeometry).attributes.position
    const t = clock.elapsedTime
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, Math.sin(x * 8 + t * 2.5) * 0.008 + Math.cos(z * 6 + t * 1.8) * 0.006)
    }
    pos.needsUpdate = true
  })

  return (
    <mesh ref={ref} geometry={geo} position={[0.45, -0.01, 0.3]} receiveShadow>
      <meshStandardMaterial
        color="#3a7db8"
        transparent
        opacity={0.75}
        roughness={0.15}
        metalness={0.3}
      />
    </mesh>
  )
}

// ── Hut ────────────────────────────────────────────────────────────
// Simple cottage: box base + cone roof + door slab.

export function Hut() {
  return (
    <group position={[-0.5, 0, -0.35]}>
      {/* walls */}
      <mesh position={[0, 0.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.28, 0.2, 0.22]} />
        <meshStandardMaterial color="#c4a67a" roughness={0.9} />
      </mesh>
      {/* roof — 4-sided pyramid aligned with box walls (rotate 45° around Y) */}
      <mesh position={[0, 0.26, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[0.22, 0.14, 4]} />
        <meshStandardMaterial color="#8b4a2a" roughness={0.8} />
      </mesh>
      {/* door */}
      <mesh position={[0, 0.06, 0.112]}>
        <boxGeometry args={[0.06, 0.1, 0.01]} />
        <meshStandardMaterial color="#5a3a1a" />
      </mesh>
      {/* chimney */}
      <mesh position={[0.08, 0.3, -0.04]} castShadow>
        <boxGeometry args={[0.04, 0.1, 0.04]} />
        <meshStandardMaterial color="#7a6a5a" />
      </mesh>
    </group>
  )
}

// ── Windmill ───────────────────────────────────────────────────────
// Stone tower + rotating blade cross.

export function Windmill() {
  const bladesRef = useRef<THREE.Group>(null)

  useFrame(({ clock }) => {
    if (bladesRef.current) {
      bladesRef.current.rotation.z = clock.elapsedTime * 0.8
    }
  })

  return (
    <group position={[0.55, 0, -0.5]}>
      {/* tower */}
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.08, 0.4, 8]} />
        <meshStandardMaterial color="#9a9080" roughness={0.9} />
      </mesh>
      {/* cap */}
      <mesh position={[0, 0.42, 0]} castShadow>
        <coneGeometry args={[0.07, 0.06, 8]} />
        <meshStandardMaterial color="#6a5a4a" />
      </mesh>
      {/* blade hub */}
      <group ref={bladesRef} position={[0, 0.35, 0.07]}>
        {[0, 1, 2, 3].map(i => (
          <mesh key={i} rotation={[0, 0, (i * Math.PI) / 2]} castShadow>
            <boxGeometry args={[0.02, 0.22, 0.005]} />
            <meshStandardMaterial color="#d4c8a0" roughness={0.7} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

// ── Trees ──────────────────────────────────────────────────────────
// Trunk + canopy, gentle sway.

const TREE_POSITIONS: [number, number, number][] = [
  [-0.25, 0, 0.55],
  [0.15, 0, 0.6],
  [-0.65, 0, 0.45],
  [-0.7, 0, -0.65],
  [0.3, 0, -0.6],
  [-0.15, 0, -0.7],
  [0.7, 0, 0.15],
]

const TREE_SCALES = [1, 0.75, 0.9, 1.1, 0.65, 0.85, 0.7]

export function Tree({ position, scale, phase }: {
  position: [number, number, number]
  scale: number
  phase: number
}) {
  const groupRef = useRef<THREE.Group>(null)

  useFrame(({ clock }) => {
    if (groupRef.current) {
      const t = clock.elapsedTime
      groupRef.current.rotation.z = Math.sin(t * 1.2 + phase) * 0.03
      groupRef.current.rotation.x = Math.cos(t * 0.9 + phase * 1.3) * 0.02
    }
  })

  const trunkH = 0.18 * scale
  const canopyR = 0.1 * scale

  return (
    <group position={position}>
      <group ref={groupRef}>
        {/* trunk */}
        <mesh position={[0, trunkH / 2, 0]} castShadow>
          <cylinderGeometry args={[0.015 * scale, 0.025 * scale, trunkH, 6]} />
          <meshStandardMaterial color="#6b4c30" roughness={0.9} />
        </mesh>
        {/* canopy */}
        <mesh position={[0, trunkH + canopyR * 0.6, 0]} castShadow>
          <icosahedronGeometry args={[canopyR, 1]} />
          <meshStandardMaterial
            color={scale > 0.9 ? '#3a7a3a' : '#4a8a3a'}
            roughness={0.8}
          />
        </mesh>
      </group>
    </group>
  )
}

export function Trees() {
  return (
    <>
      {TREE_POSITIONS.map((pos, i) => (
        <Tree key={i} position={pos} scale={TREE_SCALES[i]} phase={i * 2.1} />
      ))}
    </>
  )
}

// ── Fence (path detail) ────────────────────────────────────────────
// Small fence posts between hut and windmill.

export function Fence() {
  const posts: [number, number, number][] = []
  for (let i = 0; i < 6; i++) {
    const t = i / 5
    posts.push([
      THREE.MathUtils.lerp(-0.35, 0.4, t),
      0.03,
      THREE.MathUtils.lerp(-0.3, -0.45, t),
    ])
  }
  return (
    <>
      {posts.map((p, i) => (
        <mesh key={i} position={p} castShadow>
          <boxGeometry args={[0.015, 0.06, 0.015]} />
          <meshStandardMaterial color="#7a6040" roughness={0.9} />
        </mesh>
      ))}
    </>
  )
}

// ── Flowers (scattered detail) ─────────────────────────────────────

export function Flowers() {
  const positions = useMemo(() => {
    const pts: [number, number, number][] = []
    // deterministic scatter
    for (let i = 0; i < 18; i++) {
      const a = i * 2.399 // golden angle
      const r = 0.2 + (i / 18) * 0.6
      const x = Math.cos(a) * r * 0.9
      const z = Math.sin(a) * r * 0.85
      // skip if too close to water or structures
      if (Math.sqrt((x - 0.45) ** 2 + (z - 0.3) ** 2) < 0.38) continue
      if (Math.sqrt((x + 0.5) ** 2 + (z + 0.35) ** 2) < 0.2) continue
      pts.push([x, 0.02, z])
    }
    return pts
  }, [])

  const colors = ['#e85a7a', '#e8c85a', '#fff', '#d07ae8', '#e8a05a']

  return (
    <>
      {positions.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.012, 5, 4]} />
          <meshStandardMaterial color={colors[i % colors.length]} roughness={0.6} />
        </mesh>
      ))}
    </>
  )
}

// ── Smoke from chimney ─────────────────────────────────────────────

export function Smoke() {
  const ref = useRef<THREE.Group>(null)
  const particles = useMemo(() => {
    return Array.from({ length: 5 }, (_, i) => ({
      offset: i * 0.4,
      x: (Math.sin(i * 3.7) * 0.01),
    }))
  }, [])

  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = clock.elapsedTime
    ref.current.children.forEach((child, i) => {
      const p = particles[i]
      const age = ((t + p.offset) % 2) / 2 // 0..1 over 2s cycle
      child.position.y = age * 0.15
      child.position.x = p.x + Math.sin(t * 0.5 + i) * 0.01
      child.scale.setScalar(0.008 + age * 0.015)
      ;(child as THREE.Mesh).material = child.userData.mat
      const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial
      mat.opacity = 0.35 * (1 - age)
    })
  })

  return (
    <group ref={ref} position={[-0.42, 0.36, -0.39]}>
      {particles.map((_, i) => {
        const mat = new THREE.MeshStandardMaterial({
          color: '#c8c0b0',
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
        })
        return (
          <mesh key={i} userData={{ mat }}>
            <sphereGeometry args={[1, 6, 6]} />
            <primitive object={mat} attach="material" />
          </mesh>
        )
      })}
    </group>
  )
}

// ── Stone path to hut ──────────────────────────────────────────────

export function StonePath() {
  const stones = useMemo(() => {
    const pts: { pos: [number, number, number]; r: number }[] = []
    for (let i = 0; i < 8; i++) {
      const t = i / 7
      pts.push({
        pos: [
          THREE.MathUtils.lerp(-0.5, -0.1, t) + Math.sin(i * 2.3) * 0.03,
          0.005,
          THREE.MathUtils.lerp(-0.22, 0.15, t) + Math.cos(i * 1.7) * 0.03,
        ],
        r: 0.02 + Math.sin(i * 4.1) * 0.008,
      })
    }
    return pts
  }, [])

  return (
    <>
      {stones.map((s, i) => (
        <mesh key={i} position={s.pos as [number, number, number]} rotation={[-Math.PI / 2, 0, i * 1.1]}>
          <circleGeometry args={[s.r, 6]} />
          <meshStandardMaterial color="#8a8070" roughness={0.95} />
        </mesh>
      ))}
    </>
  )
}

// ── Base boundary (ground edge) ────────────────────────────────────
// Thin slab marking the 1:1 square boundary.

export function BaseBoundary() {
  return (
    <mesh position={[0, -0.005, 0]}>
      <boxGeometry args={[BASE, 0.01, BASE]} />
      <meshStandardMaterial color="#3a2a1a" roughness={1} />
    </mesh>
  )
}

// ── Composed diorama ───────────────────────────────────────────────

export function Diorama() {
  return (
    <group>
      <BaseBoundary />
      <Terrain />
      <Water />
      <Hut />
      <Windmill />
      <Trees />
      <Fence />
      <Flowers />
      <StonePath />
      <Smoke />
    </group>
  )
}
