import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { folder, Leva, useControls } from 'leva'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { GrassScene } from './GrassTest'
import { attachSpringBend, makeSpringUniforms, type SpringBendUniforms } from './world/springBendShader'
import {
  getSpringImpulse,
  resetSpring,
  setSpringDriving,
  setSpringTuning,
  stepSpring,
} from './world/springStore'

/**
 * SpringyTest — every "spring object" (e.g. one windmill) bends as a
 * single coherent unit around its own world-space pivot.
 *
 * Pipeline:
 *   1. Each Windmill creates its own SpringBendUniforms (pivot, up,
 *      height, impulse). On mount it traverses its own subtree and
 *      patches every material with that uniform set.
 *   2. SpringDriver integrates the global spring state from camera
 *      horizontal velocity once per frame; SpringRouter writes the
 *      shared world impulse into every registered windmill's uniforms.
 *   3. Each Windmill's pivot/up/height are recomputed each frame from
 *      its current world transform, so windmills placed at any point
 *      on the planet bend around their own base, in their own up
 *      direction, with their own height.
 *
 * Excluded: planet ground, grass, flowers (they have their own wind
 * shader; the bend would compose with that in a way that destabilizes
 * the trail brush).
 *
 * Boundary note: this route avoids TileGrid + PostFx, so P8 (vertex
 * displacement breaking N8AO normals) does not apply. Integrating
 * into the main app would need to skip bend on tiles routed through
 * PostFx, or disable N8AO for affected materials.
 */

const PLANET_RADIUS = 1.0

// ── Registry: every Windmill registers its uniforms here so the
// global driver can fan out the shared impulse each frame. ────────────
const registry: { uniforms: SpringBendUniforms; group: THREE.Object3D; height: number }[] = []
function registerSpring(uniforms: SpringBendUniforms, group: THREE.Object3D, height: number): () => void {
  const entry = { uniforms, group, height }
  registry.push(entry)
  return () => {
    const i = registry.indexOf(entry)
    if (i >= 0) registry.splice(i, 1)
  }
}

function Windmill({ position }: { position: [number, number, number] }) {
  const groupRef = useRef<THREE.Group>(null!)
  const hubRef = useRef<THREE.Group>(null!)

  const towerMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d6ccc2', roughness: 0.7, metalness: 0.05 }), [])
  const roofMat  = useMemo(() => new THREE.MeshStandardMaterial({ color: '#7a3a2a', roughness: 0.65, metalness: 0.05 }), [])
  const padMat   = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5d5247', roughness: 0.85 }), [])
  const hubMat   = useMemo(() => new THREE.MeshStandardMaterial({ color: '#3b2e22', roughness: 0.55, metalness: 0.1 }), [])
  const bladeMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5d4a36', roughness: 0.6 }), [])

  const placement = useMemo(() => {
    const p = new THREE.Vector3(...position)
    const up = p.clone().normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up)
    return { position: p, quaternion: q }
  }, [position])

  // Per-windmill uniform set. All meshes in this windmill share these
  // four uniforms, so bend is coherent across the whole structure.
  const uniforms = useMemo(() => makeSpringUniforms(), [])
  const TOTAL_HEIGHT = 0.55  // pad bottom (y=0) to blade tip (~0.36 + 0.18 = 0.54)

  // Patch every material in this windmill's subtree once mounted. The
  // patch is idempotent so re-entry is cheap; we still patch only on
  // mount to keep the GPU compile work bounded.
  useEffect(() => {
    const root = groupRef.current
    if (!root) return
    root.traverse(obj => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (m) attachSpringBend(m, { uniforms })
      }
    })
    const unregister = registerSpring(uniforms, root, TOTAL_HEIGHT)
    return () => { unregister() }
  }, [uniforms])

  useFrame((_, dt) => {
    if (hubRef.current) hubRef.current.rotation.z += dt * 1.8
  })

  return (
    <group ref={groupRef} position={placement.position} quaternion={placement.quaternion}>
      <mesh position={[0, 0.01, 0]} material={padMat}>
        <boxGeometry args={[0.16, 0.02, 0.16]} />
      </mesh>
      <mesh position={[0, 0.16, 0]} material={towerMat}>
        <cylinderGeometry args={[0.045, 0.06, 0.30, 24, 16]} />
      </mesh>
      <mesh position={[0, 0.345, 0]} material={roofMat}>
        <coneGeometry args={[0.07, 0.08, 24, 8]} />
      </mesh>
      <group position={[0, 0.36, 0.07]}>
        <mesh material={hubMat}>
          <cylinderGeometry args={[0.018, 0.018, 0.04, 16]} />
        </mesh>
        <group ref={hubRef}>
          {[0, 1, 2, 3].map(i => (
            <mesh
              key={i}
              rotation={[0, 0, (i * Math.PI) / 2]}
              position={[0, 0.09, 0]}
              material={bladeMat}
            >
              <boxGeometry args={[0.018, 0.18, 0.008]} />
            </mesh>
          ))}
        </group>
      </group>
    </group>
  )
}

/** Per-frame: integrate spring state, fan out into every registered windmill. */
function SpringDriver() {
  const { camera } = useThree()
  const prevPos = useRef(new THREE.Vector3()).current
  const initialized = useRef(false)
  const _vel = useRef(new THREE.Vector3()).current
  const _drive = useRef(new THREE.Vector3()).current
  const _worldPos = useRef(new THREE.Vector3()).current
  const _worldUp = useRef(new THREE.Vector3()).current
  const _worldQuat = useRef(new THREE.Quaternion()).current
  const _scale = useRef(new THREE.Vector3()).current

  const { stiffness, damping, driveScale, maxBend } = useControls({
    Spring: folder({
      stiffness:  { value: 120, min: 10,  max: 600,  step: 1,    label: 'k (stiffness)' },
      damping:    { value: 8,   min: 0.5, max: 40,   step: 0.1,  label: 'c (damping)' },
      driveScale: { value: 1.4, min: 0,   max: 8,    step: 0.05, label: 'drive scale' },
      maxBend:    { value: 0.7, min: 0,   max: 1.5,  step: 0.01, label: 'max bend (rad)' },
    }, { collapsed: false }),
  })

  useEffect(() => { setSpringTuning(stiffness, damping) }, [stiffness, damping])
  useEffect(() => { return () => { resetSpring() } }, [])

  useFrame((_, dt) => {
    if (!initialized.current) {
      prevPos.copy(camera.position)
      initialized.current = true
      return
    }
    const safeDt = Math.max(dt, 1e-4)
    _vel.subVectors(camera.position, prevPos).divideScalar(safeDt)
    _vel.y = 0
    _drive.copy(_vel).multiplyScalar(driveScale)
    setSpringDriving(_drive)
    stepSpring(dt)

    const imp = getSpringImpulse()
    const mag = imp.length()
    if (mag > maxBend) imp.multiplyScalar(maxBend / mag)

    // Fan out to every registered spring object — pivot, up, height
    // recomputed from the live world transform so windmills can move.
    for (const e of registry) {
      e.group.matrixWorld.decompose(_worldPos, _worldQuat, _scale)
      _worldUp.set(0, 1, 0).applyQuaternion(_worldQuat)
      e.uniforms.uSpringPivotWorld.value.copy(_worldPos)
      e.uniforms.uSpringUpWorld.value.copy(_worldUp)
      e.uniforms.uSpringHeightWorld.value = e.height
      e.uniforms.uSpringImpulseWorld.value.copy(imp)
    }

    prevPos.copy(camera.position)
  })

  return null
}

export function SpringyTest() {
  return (
    <>
      <Canvas
        camera={{ position: [0, 0.6, 2.5], fov: 45 }}
        style={{ position: 'fixed', inset: 0, background: '#0a0e0a' }}
      >
        <GrassScene />
        <Windmill position={[0, PLANET_RADIUS, 0]} />
        <Windmill position={[0.6, PLANET_RADIUS * 0.85, 0.4]} />
        <Windmill position={[-0.5, PLANET_RADIUS * 0.7, -0.6]} />
        <SpringDriver />
        <OrbitControls />
      </Canvas>
      <Leva />
      <div style={{
        position: 'fixed', top: 8, left: 8, padding: '8px 12px',
        background: 'rgba(0,0,0,0.55)', color: '#bce28b',
        font: '12px/1.4 monospace', borderRadius: 4,
        pointerEvents: 'none', maxWidth: 360,
      }}>
        SpringyTest — every windmill bends as one piece around its own
        world-space base. Drag to rotate; release to recoil. Tune k / c /
        drive in the Spring folder.
      </div>
    </>
  )
}
