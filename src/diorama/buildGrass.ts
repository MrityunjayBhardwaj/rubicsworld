/**
 * Fluffy-grass builder. Samples flat-net candidates, rejects positions that
 * fall inside any diorama prop's flat-space AABB, and emits an InstancedMesh
 * of crossed-plane blades **authored in flat cube-net space** — so it rides
 * the same cube-net → split → cube → sphere pipeline as every other diorama
 * prop (trees, hut, pond, road, …). In sphere mode the existing
 * `patchMaterialForSphere` onBeforeCompile patch spherifies grass alongside
 * the rest of the scene; in flat/cube previews the blades render upright on
 * their flat face-block.
 *
 * Wind is a **rigid rotation** of each blade around its root, Rodrigues
 * formula in the vertex shader. Blade length is strictly preserved under
 * bending (isometry). Phase is spatial — derived from the instance world
 * origin projected onto the wind direction — so the whole field moves as
 * one coherent wave rolling through the grass, not per-strand random sway.
 *
 * Density budget: blades-per-flat-unit² sampled in each 2×2 face-block
 * (24 u² total). Allowed area / blade count falls out of the exclusion
 * pass naturally.
 */
import * as THREE from 'three'

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
// is already excluded. Per-name margin overrides default exclusionMargin —
// road is a thin strip where even a tiny spillover visually overlaps; pond
// and windmill benefit from a softer skirt around the prop.
const DEFAULT_EXCLUDE = [
  'pond', 'stream', 'windmill', 'trees', 'hut', 'fence',
  'flowers', 'stonepath', 'well', 'rocks', 'road', 'smoke',
] as const

const PROP_MARGIN: Record<string, number> = {
  road:     0.14,
  pond:     0.10,
  stream:   0.08,
  windmill: 0.10,
  hut:      0.08,
}

export interface GrassOpts {
  /** Blades per flat u² sampled (before exclusion). Max instances = 24 × this. */
  densityPerUnit2?: number
  /** Outer margin added to each excluded prop's AABB (flat units). */
  exclusionMargin?: number
  /** Blade height in flat units (flat-net space). Small — e.g. 0.015. */
  bladeHeight?: number
  bladeWidth?: number
  /** Names of diorama children whose AABB kills grass inside. */
  excludeNames?: readonly string[]
  /** Tiny lift off y=0 to avoid z-fight with the flat terrain plane in
   *  non-sphere modes (the sphere terrain lives in a separate scene). */
  groundOffset?: number
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
  /** Wind speed — how fast the wave propagates through time (rad/s). */
  uWindFreq:      { value: number }
  /** Spatial frequency of the wind wave: cycles per world unit. Higher =
   *  tighter ripples; 0 collapses the field to a single synchronised sway. */
  uWaveScale:     { value: number }
  /** Maximum bend angle in radians (scaled by wave amplitude × strength). */
  uBendAmount:    { value: number }
  /** Multiplies blade height at runtime. Scaling is applied BEFORE the
   *  rigid-rotation wind, so length preservation under wind still holds. */
  uLengthScale:   { value: number }
  uBaseColor:     { value: THREE.Color }
  uTipColor:      { value: THREE.Color }
  uHueJitter:     { value: number }
}

/** Module-scoped shared uniforms — GrassPanel writes into these each render. */
export const grassUniforms: GrassUniforms = {
  uTime:         { value: 0 },
  uWindDir:      { value: new THREE.Vector2(1, 0.35).normalize() },
  uWindStrength: { value: 1.0 },
  uWindFreq:     { value: 1.5 },
  uWaveScale:    { value: 3.5 },
  uBendAmount:   { value: 0.35 },
  uLengthScale:  { value: 1.0 },
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

/** Flat-space debug data for the density map overlay. Populated at build time
 *  and consumed by GrassPanel to render a 2D preview of allowed / excluded
 *  regions on the 8×6 cross cube-net. */
export interface GrassDebugData {
  halfW: number
  halfH: number
  blocks: { face: number; cx: number; cz: number; halfSize: number }[]
  exclusions: { xMin: number; xMax: number; zMin: number; zMax: number; owner: string }[]
  flatPositions: Float32Array  // interleaved x0, z0, x1, z1, …
  stats: { candidates: number; allowed: number; excluded: number }
}
export const grassDebug: { data: GrassDebugData | null } = { data: null }

/** Crossed-plane blade: two quads on perpendicular axes, shared indexed mesh.
 *  Local frame: root at y=0, tip at y=height, blade width spans local ±w/2. */
function buildBladeGeometry(width: number, height: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const w = width / 2
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const quads = [
    { ax: 1, az: 0, nx: 0, nz: 1 }, // spans along X, facing ±Z
    { ax: 0, az: 1, nx: 1, nz: 0 }, // spans along Z, facing ±X
  ]
  for (let q = 0; q < 2; q++) {
    const base = q * 4
    const { ax, az, nx, nz } = quads[q]
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
    // Base budget sized so Leva density=10 saturates with a lush field;
    // density=1 is ~old look. ~96K candidates → ~45K survivors post-exclusion
    // (still cheap — modern GPUs eat millions of instances for breakfast).
    densityPerUnit2 = 4000,
    exclusionMargin = 0.05,
    bladeHeight     = 0.015,
    bladeWidth      = 0.003,
    excludeNames    = DEFAULT_EXCLUDE,
    groundOffset    = 0.0005,
  } = opts

  // ── Step 1: collect exclusion rects in flat XZ space ───────────────────
  // Matrices must be current — diorama was just built and may not have been
  // rendered yet, so Object3D.matrixWorld is still identity in places.
  dioramaRoot.updateMatrixWorld(true)
  type Rect = { xMin: number; xMax: number; zMin: number; zMax: number; owner: string }
  const exclusions: Rect[] = []
  const _box = new THREE.Box3()
  // Per-mesh AABBs, not per-root-group: the `trees` group spans the whole
  // planting area, so its group-AABB would kill every candidate in the gaps
  // between trunks.
  for (const name of excludeNames) {
    const root = dioramaRoot.getObjectByName(name)
    if (!root) continue
    const margin = PROP_MARGIN[name] ?? exclusionMargin
    root.traverse(leaf => {
      const m = leaf as THREE.Mesh
      if (!m.isMesh) return
      _box.makeEmpty().setFromObject(m)
      if (_box.isEmpty() || !isFinite(_box.min.x)) return
      exclusions.push({
        xMin: _box.min.x - margin,
        xMax: _box.max.x + margin,
        zMin: _box.min.z - margin,
        zMax: _box.max.z + margin,
        owner: name,
      })
    })
  }

  // ── Step 2: sample candidates per block, reject against exclusions ─────
  const candidatesPerBlock = Math.max(1, Math.floor(densityPerUnit2 * 4)) // 2×2 = 4 u²
  const totalCandidates = candidatesPerBlock * 6

  const flatPositions: THREE.Vector3[] = []
  const flatPositions2D: THREE.Vector2[] = []  // for the debug overlay
  const hues:   number[] = []
  const yaws:   number[] = []
  const scales: number[] = []
  let excluded = 0

  for (const block of FACE_BLOCKS) {
    for (let i = 0; i < candidatesPerBlock; i++) {
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
      // Flat-net authoring: root at (x, groundOffset, z). Sphere projection
      // shader (applied in sphere mode) will warp y into the radial direction;
      // in flat/cube-net/split previews the blade stays at this Y directly.
      flatPositions.push(new THREE.Vector3(flatX, groundOffset, flatZ))
      flatPositions2D.push(new THREE.Vector2(flatX, flatZ))
      hues.push(Math.random())
      yaws.push(Math.random() * Math.PI * 2)
      scales.push(0.75 + Math.random() * 0.5) // 0.75–1.25
    }
  }

  const count = flatPositions.length

  // ── Step 3: geometry + per-instance hue attribute ──────────────────────
  const geom = buildBladeGeometry(bladeWidth, bladeHeight)
  const hueAttr = new THREE.InstancedBufferAttribute(new Float32Array(hues), 1)
  geom.setAttribute('iHue', hueAttr)

  // ── Step 4: material — MSM + onBeforeCompile for rigid-rotation wind +
  //            procedural blade alpha. Sphere projection patch in TileGrid
  //            chains onto this patch via prevOBC; both stack cleanly. ────
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    transparent: false,
  })
  const ud = material.userData as { __grassPatched?: boolean }
  if (!ud.__grassPatched) {
    ud.__grassPatched = true
    material.onBeforeCompile = shader => {
      shader.uniforms.uTime         = grassUniforms.uTime
      shader.uniforms.uWindDir      = grassUniforms.uWindDir
      shader.uniforms.uWindStrength = grassUniforms.uWindStrength
      shader.uniforms.uWindFreq     = grassUniforms.uWindFreq
      shader.uniforms.uWaveScale    = grassUniforms.uWaveScale
      shader.uniforms.uBendAmount   = grassUniforms.uBendAmount
      shader.uniforms.uLengthScale  = grassUniforms.uLengthScale
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
          uniform float uWaveScale;
          uniform float uBendAmount;
          uniform float uLengthScale;
          `,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */`
          vec3 transformed = vec3(position);
          vGrassUv = uv;
          vHue = iHue;

          // --- Instance world origin (translation column of instanceMatrix).
          //     Used as the spatial reference for the wave phase so the whole
          //     field rolls as one coherent sheet in the wind direction.
          vec3 instOrigin = vec3(instanceMatrix[3].xyz);

          // --- World-space wind direction, lifted to 3D by interpreting
          //     uWindDir.x,y as (x, z) components on the world xz plane.
          vec3 worldWind3 = normalize(vec3(uWindDir.x, 0.0, uWindDir.y) + vec3(1e-4));

          // --- Spatial + temporal phase → single coherent wave.
          float spatialPhase = dot(instOrigin, worldWind3) * uWaveScale;
          float wave = sin(uTime * uWindFreq - spatialPhase);
          float gust = sin(uTime * uWindFreq * 0.47 - spatialPhase * 0.63);
          float amp  = wave * 0.75 + gust * 0.25;

          // --- Wind direction in the BLADE-LOCAL tangent plane. Extract the
          //     instance rotation by normalising each column of instanceMatrix
          //     (handles the per-instance uniform scale). Transpose = inverse
          //     for the orthonormalised rotation.
          mat3 iRot = mat3(
            normalize(instanceMatrix[0].xyz),
            normalize(instanceMatrix[1].xyz),
            normalize(instanceMatrix[2].xyz)
          );
          vec3 localWind = transpose(iRot) * worldWind3;
          vec2 bendDir2 = normalize(vec2(localWind.x, localWind.z) + vec2(1e-5));

          // --- Length-preserving rigid rotation of the blade around its root.
          //     Axis of rotation k = Y × bendDir (in the local XZ plane), so
          //     tilting by angle θ sends local +Y toward (bendDir.x, *, bendDir.y).
          //     Length is preserved by construction — rotations are isometries.
          float theta = amp * uWindStrength * uBendAmount;
          float c = cos(theta);
          float s = sin(theta);
          float oc = 1.0 - c;
          vec3 k = vec3(bendDir2.y, 0.0, -bendDir2.x);

          // Scale height by uLengthScale BEFORE the rigid rotation — this
          // grows/shrinks the blade uniformly from root. Rotation is still
          // an isometry on the scaled vector, so length preservation under
          // wind holds for whatever the user dialled in.
          vec3 p = vec3(position.x, position.y * uLengthScale, position.z);

          // Rodrigues: p' = p·cos + (k×p)·sin + k·(k·p)·(1−cos)
          vec3 kxp = cross(k, p);
          float kdotp = dot(k, p);
          transformed = p * c + kxp * s + k * kdotp * oc;
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
          float ux     = abs(vGrassUv.x - 0.5) * 2.0;
          float taper  = mix(1.0, 0.18, vGrassUv.y);
          if (ux > taper) discard;
          vec3 gc = mix(uBaseColor, uTipColor, vGrassUv.y);
          gc *= 1.0 + (vHue - 0.5) * 2.0 * uHueJitter;
          diffuseColor.rgb *= gc;
          `,
        )
    }
  }

  // ── Step 5: InstancedMesh + per-instance matrices ─────────────────────
  const mesh = new THREE.InstancedMesh(geom, material, count)
  mesh.name = 'grass'
  // Authoring frame is flat cube-net space. Sphere projection moves vertices
  // far from the geometry's bounding sphere, so rely on the surrounding cell
  // clip-planes for culling instead of frustum culling (matches every other
  // patched prop in the diorama).
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  // Don't let raycasts hit grass — the DoF cursor-follow and tile interaction
  // raycast against the planet and must land on the tile-owning surface.
  mesh.raycast = () => {}

  const _mat   = new THREE.Matrix4()
  const _q     = new THREE.Quaternion()
  const _scale = new THREE.Vector3()
  const _axisY = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < count; i++) {
    // Yaw-only orientation: blade local +Y stays aligned with flat +Y.
    // After the sphere-projection vertex shader runs in sphere mode, flat +Y
    // maps to the sphere radial direction, so blades stand upright on any
    // mode (flat net / split / cube / sphere).
    _q.setFromAxisAngle(_axisY, yaws[i])
    const s = scales[i]
    _scale.set(s, s, s)
    _mat.compose(flatPositions[i], _q, _scale)
    mesh.setMatrixAt(i, _mat)
  }
  mesh.instanceMatrix.needsUpdate = true

  // Initial visible count matches Leva's default density slider value (5/10).
  // GrassPanel's useEffect may fire BEFORE this mesh is published (the panel
  // mounts outside Canvas), so set the default here to avoid a first-frame
  // flash at full density.
  mesh.count = Math.floor(count * 0.5)

  // Publish shared handle so Leva panel can scale mesh.count + toggle visible.
  grassRefs.mesh = mesh
  grassRefs.maxCount = count

  // Publish density-map debug data for the overlay.
  const flatArr = new Float32Array(flatPositions2D.length * 2)
  for (let i = 0; i < flatPositions2D.length; i++) {
    flatArr[i * 2] = flatPositions2D[i].x
    flatArr[i * 2 + 1] = flatPositions2D[i].y
  }
  grassDebug.data = {
    halfW: 4,
    halfH: 3,
    blocks: FACE_BLOCKS.map(b => ({ face: b.face, cx: b.cx, cz: b.cz, halfSize: 1 })),
    exclusions: exclusions.map(e => ({ ...e })),
    flatPositions: flatArr,
    stats: { candidates: totalCandidates, allowed: count, excluded },
  }
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
