/**
 * Fluffy-grass builder. Samples flat-net candidates, rejects positions that
 * fall inside any diorama prop's flat-space AABB, projects surviving roots
 * onto the unit sphere, and emits an InstancedMesh of crossed-plane blades.
 *
 * The density budget is stated in blades-per-flat-unit². The 6 face-blocks
 * are each 2×2 → 24 u² total domain. Allowed area (and therefore allocated
 * blade count) falls out naturally after exclusion.
 *
 * Wind is a vertex-shader bend applied in blade-local space with a
 * per-instance phase offset. Fragment shader generates a procedural blade
 * taper (no texture) + tip/base colour lerp. Alpha-test; no blend sort.
 *
 * Runs independently of the per-tile sphere-projection pipeline — grass is
 * authored directly on the sphere and added to the sphere-terrain scene,
 * so it does not ride tile rotations. Per-tile ownership is future work;
 * the density-map approach here partitions cleanly by flat block.
 */
import * as THREE from 'three'
import { FACES } from '../world/faces'

// Face-block definitions mirroring `buildDiorama.ts` header geometry.
// centreX/centreZ are the (x, z) midpoint of each 2×2 block in flat space.
const FACE_BLOCKS: readonly { face: 0 | 1 | 2 | 3 | 4 | 5; cx: number; cz: number }[] = [
  { face: 4, cx: -1, cz:  0 }, // E (+Z)
  { face: 0, cx:  1, cz:  0 }, // A (+X)
  { face: 1, cx: -3, cz:  0 }, // B (-X)
  { face: 5, cx:  3, cz:  0 }, // F (-Z)
  { face: 2, cx: -1, cz:  2 }, // C (+Y)
  { face: 3, cx: -1, cz: -2 }, // D (-Y)
] as const

// Named diorama roots that should get NO grass around them. `terrain` is the
// domain itself; `birds` are airborne; `car` is always over the road, which
// is already excluded. Margin is applied on top of each AABB.
const DEFAULT_EXCLUDE = [
  'pond', 'stream', 'windmill', 'trees', 'hut', 'fence',
  'flowers', 'stonepath', 'well', 'rocks', 'road', 'smoke',
] as const

export interface GrassOpts {
  /** Blades per flat u² sampled (before exclusion). Max instances = 24 × this. */
  densityPerUnit2?: number
  /** Outer margin added to each excluded prop's AABB (flat units). */
  exclusionMargin?: number
  /** Blade height in flat/sphere units. Sphere radius is 1, so 0.08 ≈ 5° arc. */
  bladeHeight?: number
  bladeWidth?: number
  /** Names of diorama children whose AABB kills grass inside. */
  excludeNames?: readonly string[]
}

export interface GrassResult {
  mesh: THREE.InstancedMesh
  uniforms: GrassUniforms
  update: (elapsed: number) => void
  dispose: () => void
  stats: { candidates: number; allowed: number; excluded: number }
}

export interface GrassUniforms {
  uTime:          { value: number }
  uWindDir:       { value: THREE.Vector2 }
  uWindStrength:  { value: number }
  uWindFreq:      { value: number }
  uBendAmount:    { value: number }
  uBaseColor:     { value: THREE.Color }
  uTipColor:      { value: THREE.Color }
  uHueJitter:     { value: number }
}

/** Module-scoped shared uniforms — GrassPanel writes into these each render. */
export const grassUniforms: GrassUniforms = {
  uTime:         { value: 0 },
  uWindDir:      { value: new THREE.Vector2(1, 0.35).normalize() },
  uWindStrength: { value: 1.0 },
  uWindFreq:     { value: 1.8 },
  uBendAmount:   { value: 0.18 },
  uBaseColor:    { value: new THREE.Color('#3c6a2a') },
  uTipColor:     { value: new THREE.Color('#cfe489') },
  uHueJitter:    { value: 0.18 },
}

/** Shared handle so the Leva panel can scale visible instance count without
 *  rebuilding geometry. `maxCount` is the allocated instance budget; the
 *  visible count is `Math.floor(maxCount * density)`. */
export const grassRefs: {
  mesh: THREE.InstancedMesh | null
  maxCount: number
} = { mesh: null, maxCount: 0 }

/** Flat (x, z) in block `block` → sphere world position. Formula matches the
 *  shader: cube-face-local (u, v) along face.right / face.up, plus the face
 *  normal, all normalized. */
function flatToSphere(
  flatX: number,
  flatZ: number,
  faceIdx: number,
  cx: number,
  cz: number,
  out: THREE.Vector3,
): void {
  const face = FACES[faceIdx]
  const u = flatX - cx
  const v = flatZ - cz
  out.set(0, 0, 0)
    .addScaledVector(face.right, u)
    .addScaledVector(face.up, v)
    .add(face.normal)
    .normalize()
}

/** Crossed-plane blade: two quads on perpendicular axes, shared indexed mesh.
 *  Local frame: root at y=0, tip at y=height, blade width spans local ±w/2. */
function buildBladeGeometry(width: number, height: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const w = width / 2
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  // Two quads rotated 90° around local Y — xAxis plane then zAxis plane.
  const quads = [
    { ax: 1, az: 0, nx: 0, nz: 1 }, // spans along X, facing ±Z
    { ax: 0, az: 1, nx: 1, nz: 0 }, // spans along Z, facing ±X
  ]
  for (let q = 0; q < 2; q++) {
    const base = q * 4
    const { ax, az, nx, nz } = quads[q]
    // Four corners; UV y = 0 at root, 1 at tip; UV x = 0 left, 1 right
    positions.push(
      -w * ax, 0,       -w * az,
      +w * ax, 0,       +w * az,
      +w * ax, height,  +w * az,
      -w * ax, height,  -w * az,
    )
    uvs.push(0, 0,  1, 0,  1, 1,  0, 1)
    for (let i = 0; i < 4; i++) normals.push(nx, 0, nz)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2))
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3))
  g.setIndex(indices)
  return g
}

export function buildGrass(dioramaRoot: THREE.Object3D, opts: GrassOpts = {}): GrassResult {
  const {
    densityPerUnit2 = 400,
    exclusionMargin = 0.05,
    bladeHeight     = 0.075,
    bladeWidth      = 0.014,
    excludeNames    = DEFAULT_EXCLUDE,
  } = opts

  // ── Step 1: collect exclusion rects in flat XZ space ───────────────────
  // Matrices must be current — diorama was just built and may not have been
  // rendered yet, so Object3D.matrixWorld is still identity in places.
  dioramaRoot.updateMatrixWorld(true)
  type Rect = { xMin: number; xMax: number; zMin: number; zMax: number }
  const exclusions: Rect[] = []
  const _box = new THREE.Box3()
  const excludeSet = new Set(excludeNames)
  // Per-mesh AABBs, not per-root-group: the `trees` group spans the whole
  // planting area, so its group-AABB would kill every candidate in the gaps
  // between trunks. Walk each excluded root's descendants and record a rect
  // per leaf mesh so grass fills the spaces between instances.
  dioramaRoot.traverse(root => {
    if (!root.name || !excludeSet.has(root.name)) return
    root.traverse(leaf => {
      const m = leaf as THREE.Mesh
      if (!m.isMesh) return
      _box.makeEmpty().setFromObject(m)
      if (_box.isEmpty() || !isFinite(_box.min.x)) return
      exclusions.push({
        xMin: _box.min.x - exclusionMargin,
        xMax: _box.max.x + exclusionMargin,
        zMin: _box.min.z - exclusionMargin,
        zMax: _box.max.z + exclusionMargin,
      })
    })
  })

  // ── Step 2: sample candidates per block, reject against exclusions ─────
  const candidatesPerBlock = Math.max(1, Math.floor(densityPerUnit2 * 4)) // 2×2 = 4 u²
  const totalCandidates = candidatesPerBlock * 6

  const spherePositions: THREE.Vector3[] = []
  const hues:   number[] = []
  const yaws:   number[] = []
  const scales: number[] = []
  const _tmp = new THREE.Vector3()
  let excluded = 0

  for (const block of FACE_BLOCKS) {
    for (let i = 0; i < candidatesPerBlock; i++) {
      // Uniform in each 2×2 block. Stratified would give more even coverage
      // but uniform + enough samples reads as natural; cheaper at build time.
      const flatX = block.cx + (Math.random() * 2 - 1)
      const flatZ = block.cz + (Math.random() * 2 - 1)
      let inside = false
      for (const r of exclusions) {
        if (flatX >= r.xMin && flatX <= r.xMax && flatZ >= r.zMin && flatZ <= r.zMax) {
          inside = true
          break
        }
      }
      if (inside) { excluded++; continue }
      flatToSphere(flatX, flatZ, block.face, block.cx, block.cz, _tmp)
      spherePositions.push(_tmp.clone())
      hues.push(Math.random())
      yaws.push(Math.random() * Math.PI * 2)
      scales.push(0.75 + Math.random() * 0.5) // 0.75–1.25
    }
  }

  const count = spherePositions.length

  // ── Step 3: geometry + per-instance hue attribute ──────────────────────
  const geom = buildBladeGeometry(bladeWidth, bladeHeight)
  const hueAttr = new THREE.InstancedBufferAttribute(new Float32Array(hues), 1)
  geom.setAttribute('iHue', hueAttr)

  // ── Step 4: material — MSM + onBeforeCompile for wind + procedural alpha ─
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    transparent: false,
  })
  // Idempotent guard — InstancedMesh clones don't happen here but keep the
  // pattern consistent with other patched materials in the project (P-class
  // hetvabhasa: stacked onBeforeCompile → duplicate declarations).
  const ud = material.userData as { __grassPatched?: boolean }
  if (!ud.__grassPatched) {
    ud.__grassPatched = true
    material.onBeforeCompile = shader => {
      shader.uniforms.uTime         = grassUniforms.uTime
      shader.uniforms.uWindDir      = grassUniforms.uWindDir
      shader.uniforms.uWindStrength = grassUniforms.uWindStrength
      shader.uniforms.uWindFreq     = grassUniforms.uWindFreq
      shader.uniforms.uBendAmount   = grassUniforms.uBendAmount
      shader.uniforms.uBaseColor    = grassUniforms.uBaseColor
      shader.uniforms.uTipColor     = grassUniforms.uTipColor
      shader.uniforms.uHueJitter    = grassUniforms.uHueJitter

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */`
          #include <common>
          attribute float iHue;
          varying float vHue;
          varying vec2  vGrassUv;
          uniform float uTime;
          uniform vec2  uWindDir;
          uniform float uWindStrength;
          uniform float uWindFreq;
          uniform float uBendAmount;
          `,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */`
          vec3 transformed = vec3(position);
          vGrassUv = uv;
          vHue = iHue;
          float bendT = uv.y;
          // Per-instance phase from hash of iHue; keeps blades out of sync.
          float phase = iHue * 6.28318;
          float wave1 = sin(uTime * uWindFreq + phase);
          float wave2 = sin(uTime * uWindFreq * 0.47 + phase * 1.7);
          // Blade-local displacement. World-frame direction isn't applied
          // because per-instance random yaw already randomises world bend;
          // combining two frequencies gives a figure-8-ish tip motion.
          float bend = bendT * bendT * uWindStrength * uBendAmount;
          transformed.x += wave1 * bend * uWindDir.x;
          transformed.z += wave2 * bend * uWindDir.y;
          `,
        )

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */`
          #include <common>
          varying float vHue;
          varying vec2  vGrassUv;
          uniform vec3  uBaseColor;
          uniform vec3  uTipColor;
          uniform float uHueJitter;
          `,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */`
          // Procedural blade shape — taper narrower toward tip, discard
          // fragments outside the taper envelope. alphaTest handles sorting.
          float ux     = abs(vGrassUv.x - 0.5) * 2.0; // 0 centre → 1 edge
          float taper  = mix(1.0, 0.18, vGrassUv.y);  // width at this height
          if (ux > taper) discard;
          vec3 gc = mix(uBaseColor, uTipColor, vGrassUv.y);
          // Per-instance hue shove: darker/lighter tufts for variety.
          gc *= 1.0 + (vHue - 0.5) * 2.0 * uHueJitter;
          diffuseColor.rgb *= gc;
          `,
        )
    }
  }

  // ── Step 5: InstancedMesh + per-instance matrices ─────────────────────
  const mesh = new THREE.InstancedMesh(geom, material, count)
  mesh.name = 'grass'
  // Sphere-positioned, authored directly in terrainScene; bounding box as
  // Three computes it from blade-local geometry would cull most of the ring.
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false

  const _mat   = new THREE.Matrix4()
  const _q     = new THREE.Quaternion()
  const _yawQ  = new THREE.Quaternion()
  const _scale = new THREE.Vector3()
  const _up    = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < count; i++) {
    const sp = spherePositions[i]
    // Blade local Y → sphere surface normal at root.
    _q.setFromUnitVectors(_up, sp)
    _yawQ.setFromAxisAngle(sp, yaws[i])
    _q.premultiply(_yawQ)
    const s = scales[i]
    _scale.set(s, s, s)
    _mat.compose(sp, _q, _scale)
    mesh.setMatrixAt(i, _mat)
  }
  mesh.instanceMatrix.needsUpdate = true

  // Publish shared handle so Leva panel can scale mesh.count + toggle visible.
  grassRefs.mesh = mesh
  grassRefs.maxCount = count
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__grass = { mesh, uniforms: grassUniforms, refs: grassRefs }
  }

  const update = (elapsed: number) => {
    grassUniforms.uTime.value = elapsed
  }

  const dispose = () => {
    geom.dispose()
    material.dispose()
    if (grassRefs.mesh === mesh) {
      grassRefs.mesh = null
      grassRefs.maxCount = 0
    }
  }

  return {
    mesh,
    uniforms: grassUniforms,
    update,
    dispose,
    stats: { candidates: totalCandidates, allowed: count, excluded },
  }
}
