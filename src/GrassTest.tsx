import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { folder, Leva, useControls } from 'leva'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  createFlowerMaterial,
  createGrassMaterial,
  flowerColorUniforms,
  FLOWER_KEYS,
  GRASS_TRAIL_N,
  grassUniforms,
  type FlowerKey,
} from './diorama/buildGrass'

/**
 * GrassTest — the main grass + flower material pipeline on a simple sphere.
 *
 * Uses `createGrassMaterial` + `createFlowerMaterial` directly (same
 * shaders the main app compiles) and the shared `grassUniforms` +
 * `flowerColorUniforms` modules (so Leva writes reach the exact same
 * uniforms main would). No dioramaRoot, no TileGrid per-tile transforms —
 * modelMatrix is identity so the world-space trail block can be verified
 * in isolation.
 *
 * Leva panel mirrors GrassPanel's Grass and Flowers folders (minus the
 * density-map save/load buttons which rely on the diorama pipeline).
 *
 * Served at /GrassTest/ via pathname gate in main.tsx.
 */

const PLANET_RADIUS = 1.0
const BLADE_W = 0.012
const BLADE_H = 0.12
const FLOWER_W = 0.025
const FLOWER_H = 0.11

// ── geometry ──────────────────────────────────────────────────────────────
// Local lightweight builders (buildGrass exports buildBladeGeometry but the
// cube-net uv math there is tuned for the diorama surface; here we just need
// tall thin quads with y∈[0,1]-ish).
function makeBladeGeometry(w: number, h: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 1, 4)
  g.translate(0, h / 2, 0)
  return g
}

// ── orientation helper ────────────────────────────────────────────────────
const _tmpUp = new THREE.Vector3()
const _tmpTangent = new THREE.Vector3()
const _tmpBitangent = new THREE.Vector3()
const _tmpQuat = new THREE.Quaternion()
const _tmpEuler = new THREE.Euler()
const _tmpMat = new THREE.Matrix4()
const _worldUp = new THREE.Vector3(0, 1, 0)
const _fallbackUp = new THREE.Vector3(1, 0, 0)
const _scaleVec = new THREE.Vector3()
function orientForSurfacePoint(pos: THREE.Vector3, out: THREE.Matrix4, yaw: number, scale: number): void {
  _tmpUp.copy(pos).normalize()
  const ref = Math.abs(_tmpUp.dot(_worldUp)) > 0.95 ? _fallbackUp : _worldUp
  _tmpTangent.copy(ref).cross(_tmpUp).normalize()
  _tmpBitangent.copy(_tmpUp).cross(_tmpTangent).normalize()
  out.makeBasis(_tmpTangent, _tmpUp, _tmpBitangent)
  // Apply yaw AROUND the local up (already column 1 of the basis), then
  // uniform scale, then set world translation. Scale is applied after
  // rotation so the blade pivots at its root (pos).
  _tmpEuler.set(0, yaw, 0, 'XYZ')
  _tmpQuat.setFromEuler(_tmpEuler)
  _tmpMat.makeRotationFromQuaternion(_tmpQuat)
  out.multiply(_tmpMat)
  out.scale(_scaleVec.set(scale, scale, scale))
  out.setPosition(pos)
}

// ── scene ─────────────────────────────────────────────────────────────────

interface Bucket {
  key: 'grass' | FlowerKey
  count: number
  material: THREE.MeshStandardMaterial
  geometry: THREE.BufferGeometry
}

export function GrassScene() {
  const { camera } = useThree()

  // ── Leva: mirror GrassPanel's Grass and Flowers folders ────────────────
  const controls = useControls({
    Grass: folder({
      visible:       { value: true, label: 'visible' },
      bladeCount:    { value: 6000, min: 500, max: 30000, step: 500, label: 'total blades' },
      length:        { value: grassUniforms.uLengthScale.value,  min: 0.1, max: 6, step: 0.01, label: 'length' },
      windSpeed:     { value: grassUniforms.uWindFreq.value,     min: 0, max: 6, step: 0.01, label: 'wind speed' },
      windStrength:  { value: grassUniforms.uWindStrength.value, min: 0, max: 4, step: 0.01, label: 'wind strength' },
      bendAmount:    { value: grassUniforms.uBendAmount.value,   min: 0, max: 1.2, step: 0.005, label: 'bend (rad)' },
      waveScale:     { value: grassUniforms.uWaveScale.value,    min: 0, max: 12, step: 0.05, label: 'wave scale (spatial)' },
      windDirX:      { value: grassUniforms.uWindDir.value.x,    min: -1, max: 1, step: 0.01, label: 'wind dir x' },
      windDirZ:      { value: grassUniforms.uWindDir.value.y,    min: -1, max: 1, step: 0.01, label: 'wind dir z' },
      baseColor:     { value: '#' + grassUniforms.uBaseColor.value.getHexString(), label: 'base colour' },
      tipColor:      { value: '#' + grassUniforms.uTipColor.value.getHexString(),  label: 'tip colour' },
      stemColor:     { value: '#' + grassUniforms.uStemColor.value.getHexString(), label: 'flower stem colour' },
      hueJitter:     { value: grassUniforms.uHueJitter.value, min: 0, max: 0.5, step: 0.01, label: 'hue jitter' },
      hoverRadius:   { value: grassUniforms.uHoverRadius.value,   min: 0.02, max: 0.8, step: 0.005, label: 'hover radius (m)' },
      hoverStrength: { value: grassUniforms.uHoverStrength.value, min: 0,    max: 3,   step: 0.01,  label: 'hover strength' },
      trailDecay:    { value: grassUniforms.uTrailDecay.value,    min: 0.1,  max: 4,   step: 0.05,  label: 'trail decay (s)' },
    }, { collapsed: false }),
    Flowers: folder({
      flowerPct:    { value: 25, min: 0, max: 100, step: 0.5, label: 'flower % (vs grass)' },
      pinkWeight:   { value: 1.0, min: 0, max: 1, step: 0.01, label: 'pink ratio' },
      purpleWeight: { value: 1.0, min: 0, max: 1, step: 0.01, label: 'purple ratio' },
      yellowWeight: { value: 1.0, min: 0, max: 1, step: 0.01, label: 'yellow ratio' },
      redWeight:    { value: 1.0, min: 0, max: 1, step: 0.01, label: 'red ratio' },
      pinkColor:    { value: '#' + flowerColorUniforms.pink.value.getHexString(),   label: 'pink' },
      purpleColor:  { value: '#' + flowerColorUniforms.purple.value.getHexString(), label: 'purple' },
      yellowColor:  { value: '#' + flowerColorUniforms.yellow.value.getHexString(), label: 'yellow' },
      redColor:     { value: '#' + flowerColorUniforms.red.value.getHexString(),    label: 'red' },
    }, { collapsed: true }),
  })

  // ── Bind Leva → shared uniforms ────────────────────────────────────────
  useEffect(() => {
    grassUniforms.uLengthScale.value   = controls.length
    grassUniforms.uWindFreq.value      = controls.windSpeed
    grassUniforms.uWindStrength.value  = controls.windStrength
    grassUniforms.uBendAmount.value    = controls.bendAmount
    grassUniforms.uWaveScale.value     = controls.waveScale
    grassUniforms.uWindDir.value.set(controls.windDirX, controls.windDirZ)
    grassUniforms.uHueJitter.value     = controls.hueJitter
    grassUniforms.uBaseColor.value.set(controls.baseColor)
    grassUniforms.uTipColor.value.set(controls.tipColor)
    grassUniforms.uStemColor.value.set(controls.stemColor)
    grassUniforms.uHoverRadius.value   = controls.hoverRadius
    grassUniforms.uHoverStrength.value = controls.hoverStrength
    grassUniforms.uTrailDecay.value    = controls.trailDecay
    grassUniforms.uHoverActive.value   = 1  // per-stamp age-gated
    flowerColorUniforms.pink.value.set(controls.pinkColor)
    flowerColorUniforms.purple.value.set(controls.purpleColor)
    flowerColorUniforms.yellow.value.set(controls.yellowColor)
    flowerColorUniforms.red.value.set(controls.redColor)
  }, [controls])

  // ── Geometries (memoized; recreated only if blade size changes, which it doesn't) ──
  const grassGeometry  = useMemo(() => makeBladeGeometry(BLADE_W, BLADE_H), [])
  const flowerGeometry = useMemo(() => makeBladeGeometry(FLOWER_W, FLOWER_H), [])

  // ── Materials — the REAL main-app materials ────────────────────────────
  const grassMaterial  = useMemo(() => createGrassMaterial(), [])
  const flowerMaterials = useMemo(() => ({
    pink:   createFlowerMaterial(flowerColorUniforms.pink),
    purple: createFlowerMaterial(flowerColorUniforms.purple),
    yellow: createFlowerMaterial(flowerColorUniforms.yellow),
    red:    createFlowerMaterial(flowerColorUniforms.red),
  }), [])

  // ── Mesh refs — one per bucket ─────────────────────────────────────────
  const grassMeshRef  = useRef<THREE.InstancedMesh>(null!)
  const pinkMeshRef   = useRef<THREE.InstancedMesh>(null!)
  const purpleMeshRef = useRef<THREE.InstancedMesh>(null!)
  const yellowMeshRef = useRef<THREE.InstancedMesh>(null!)
  const redMeshRef    = useRef<THREE.InstancedMesh>(null!)

  // ── Populate instances whenever total count or flower distribution changes ──
  useEffect(() => {
    const totalFlowers = Math.floor(controls.bladeCount * controls.flowerPct / 100)
    const totalGrass   = controls.bladeCount - totalFlowers

    const weights = {
      pink:   controls.pinkWeight,
      purple: controls.purpleWeight,
      yellow: controls.yellowWeight,
      red:    controls.redWeight,
    }
    const wSum = weights.pink + weights.purple + weights.yellow + weights.red || 1
    const counts = {
      pink:   Math.round(totalFlowers * weights.pink   / wSum),
      purple: Math.round(totalFlowers * weights.purple / wSum),
      yellow: Math.round(totalFlowers * weights.yellow / wSum),
      red:    Math.round(totalFlowers * weights.red    / wSum),
    }

    const meshes: Record<Bucket['key'], { ref: THREE.InstancedMesh; count: number }> = {
      grass:  { ref: grassMeshRef.current,  count: totalGrass },
      pink:   { ref: pinkMeshRef.current,   count: counts.pink },
      purple: { ref: purpleMeshRef.current, count: counts.purple },
      yellow: { ref: yellowMeshRef.current, count: counts.yellow },
      red:    { ref: redMeshRef.current,    count: counts.red },
    }

    const pos = new THREE.Vector3()
    const mat = new THREE.Matrix4()
    for (const key of Object.keys(meshes) as Array<Bucket['key']>) {
      const { ref, count } = meshes[key]
      if (!ref) continue
      const hues = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        pos.randomDirection().multiplyScalar(PLANET_RADIUS)
        const s = 0.7 + Math.random() * 0.6
        orientForSurfacePoint(pos, mat, Math.random() * Math.PI * 2, s)
        ref.setMatrixAt(i, mat)
        hues[i] = Math.random()
      }
      ref.instanceMatrix.needsUpdate = true
      ref.count = count
      ref.geometry.setAttribute('iHue', new THREE.InstancedBufferAttribute(hues, 1))
    }
  }, [
    controls.bladeCount, controls.flowerPct,
    controls.pinkWeight, controls.purpleWeight, controls.yellowWeight, controls.redWeight,
  ])

  // ── Cursor → trail ring buffer ─────────────────────────────────────────
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const planetSphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), PLANET_RADIUS), [])
  const pointer = useRef(new THREE.Vector2())
  const pointerOver = useRef(false)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = -((e.clientY / window.innerHeight) * 2 - 1)
      pointerOver.current = true
    }
    const onLeave = () => { pointerOver.current = false }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  const trailIdx = useRef(0)
  const lastStampT = useRef(-1)
  const lastStampPos = useRef(new THREE.Vector3(1e9, 1e9, 1e9))
  const STAMP_MIN_INTERVAL = 0.02
  const STAMP_MIN_DIST = 0.008

  const debugSphereRef = useRef<THREE.Mesh>(null!)
  const hit = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }) => {
    const now = clock.elapsedTime
    grassUniforms.uTime.value = now
    grassUniforms.uNow.value = now

    if (!pointerOver.current) return
    raycaster.setFromCamera(pointer.current, camera)
    if (!raycaster.ray.intersectSphere(planetSphere, hit)) return
    if (debugSphereRef.current) debugSphereRef.current.position.copy(hit)

    const dt = now - lastStampT.current
    const dd = lastStampPos.current.distanceTo(hit)
    if (dt < STAMP_MIN_INTERVAL && dd < STAMP_MIN_DIST) return

    const i = trailIdx.current
    const flat = grassUniforms.uTrailPos.value
    flat[i * 3 + 0] = hit.x
    flat[i * 3 + 1] = hit.y
    flat[i * 3 + 2] = hit.z
    grassUniforms.uTrailTime.value[i] = now
    trailIdx.current = (i + 1) % GRASS_TRAIL_N
    lastStampT.current = now
    lastStampPos.current.copy(hit)
  })

  const MAX_BUCKET = 30000  // safe ceiling for any bucket
  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 5, 2]} intensity={1.2} />

      <mesh>
        <sphereGeometry args={[PLANET_RADIUS * 0.995, 64, 32]} />
        <meshStandardMaterial color="#1f2d1a" roughness={0.9} />
      </mesh>

      {controls.visible && (
        <>
          <instancedMesh ref={grassMeshRef}  args={[grassGeometry,  grassMaterial,               MAX_BUCKET]} />
          <instancedMesh ref={pinkMeshRef}   args={[flowerGeometry, flowerMaterials.pink,        MAX_BUCKET]} />
          <instancedMesh ref={purpleMeshRef} args={[flowerGeometry, flowerMaterials.purple,      MAX_BUCKET]} />
          <instancedMesh ref={yellowMeshRef} args={[flowerGeometry, flowerMaterials.yellow,      MAX_BUCKET]} />
          <instancedMesh ref={redMeshRef}    args={[flowerGeometry, flowerMaterials.red,         MAX_BUCKET]} />
        </>
      )}

      <mesh ref={debugSphereRef}>
        <sphereGeometry args={[0.02, 16, 16]} />
        <meshBasicMaterial color="#ff33aa" />
      </mesh>
    </>
  )
}

export function GrassTest() {
  // Touch the re-exported constant so bundlers don't tree-shake it and so
  // we stay in sync if someone changes the trail ring size.
  void FLOWER_KEYS
  return (
    <>
      <Canvas
        camera={{ position: [0, 0.6, 2.5], fov: 45 }}
        style={{ position: 'fixed', inset: 0, background: '#0a0e0a' }}
      >
        <GrassScene />
        <OrbitControls />
      </Canvas>
      <Leva />
      <div style={{
        position: 'fixed', top: 8, left: 8, padding: '8px 12px',
        background: 'rgba(0,0,0,0.55)', color: '#bce28b',
        font: '12px/1.4 monospace', borderRadius: 4,
        pointerEvents: 'none',
      }}>
        GrassTest — real grass + flower materials on a sphere. Wind + hover trail active.
      </div>
    </>
  )
}
