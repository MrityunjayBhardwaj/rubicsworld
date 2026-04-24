/**
 * Meadow builder — grass + 4 flower types (pink / purple / yellow / red)
 * sampled as ONE categorical pass so the allocated candidates are shared:
 * the user's flower-% knob trades grass for flowers without double-placing
 * either one.
 *
 * Each category lives in its own InstancedMesh so `mesh.count` gives
 * independent per-category visibility control without a rebuild. All 5
 * materials share the same wind vertex shader (rigid Rodrigues rotation
 * around the blade root — length is preserved as a strict isometry) and
 * the same grassUniforms for spatial/temporal wave phase. Fragment differs:
 * grass uses a base→tip colour gradient on a tapered blade; flowers use a
 * narrow stem below + a coloured circular blossom above, per-mesh uniform.
 *
 * Authored in flat cube-net space so every mesh rides the existing
 * cube-net → split → cube → sphere pipeline with patchMaterialForSphere
 * chaining onto the meadow vertex patch.
 */
import * as THREE from 'three'

// Ground discovery — grass emits from the AABB of the first mesh in the
// diorama whose name starts with "ground" or "terrain" (case-insensitive,
// so Blender-exported "terrain.001" matches). Authoritative source of the
// meadow footprint; no hardcoded 8×6 fallback.
const GROUND_NAME_PREFIXES = ['ground', 'terrain'] as const

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

// ── Flower type keys ───────────────────────────────────────────────────────

export type FlowerKey = 'pink' | 'purple' | 'yellow' | 'red'
export const FLOWER_KEYS: readonly FlowerKey[] = ['pink', 'purple', 'yellow', 'red'] as const
export type Bucket = 'grass' | FlowerKey
const BUCKETS: readonly Bucket[] = ['grass', ...FLOWER_KEYS] as const

// ── Options / result / uniforms ────────────────────────────────────────────

export interface GrassOpts {
  densityPerUnit2?: number
  exclusionMargin?: number
  /** Grass blade height (thin tapered blade). Small — e.g. 0.015. */
  bladeHeight?: number
  bladeWidth?: number
  /** Flower blade height — a bit taller so the blossom reads above grass. */
  flowerHeight?: number
  flowerWidth?: number
  excludeNames?: readonly string[]
  groundOffset?: number
  maskImage?: ImageData | null
  maskThreshold?: number
}

export interface GrassUniforms {
  uTime:          { value: number }
  uWindDir:       { value: THREE.Vector2 }
  uWindStrength:  { value: number }
  uWindFreq:      { value: number }
  uWaveScale:     { value: number }
  uBendAmount:    { value: number }
  uLengthScale:   { value: number }
  uBaseColor:     { value: THREE.Color }
  uTipColor:      { value: THREE.Color }
  uHueJitter:     { value: number }
  /** Shared across all flower materials (stem colour). */
  uStemColor:     { value: THREE.Color }
}

/** Module-scoped uniforms shared by grass + flowers (wind, lighting-ish). */
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
  uStemColor:    { value: new THREE.Color('#3f6a2c') },
}

/** Per-flower-colour uniforms — one vec3 per flower type, written by Leva. */
export const flowerColorUniforms: Record<FlowerKey, { value: THREE.Color }> = {
  pink:   { value: new THREE.Color('#ff6aa3') },
  purple: { value: new THREE.Color('#b868d8') },
  yellow: { value: new THREE.Color('#f5d23a') },
  red:    { value: new THREE.Color('#e03a3a') },
}

export interface GrassResult {
  grass: THREE.InstancedMesh
  flowers: Record<FlowerKey, THREE.InstancedMesh>
  meshes: THREE.InstancedMesh[]   // convenience — [grass, pink, purple, yellow, red]
  uniforms: GrassUniforms
  update: (elapsed: number) => void
  dispose: () => void
  stats: { candidates: number; allowed: number; excluded: number; perBucket: Record<Bucket, number> }
}

export const grassRefs: {
  mesh: THREE.InstancedMesh | null             // grass mesh (kept for back-compat)
  maxCount: number                              // grass max count
  meadowMeshes: THREE.InstancedMesh[]           // all five meshes in build order
  meadowMax: Record<Bucket, number>             // per-bucket allocated max
  captureTopView: (() => Promise<Blob | null>) | null
  rebuildWithMask: ((mask: ImageData | null) => void) | null
  /** Build a throwaway flat cube-net diorama (no meadow, no shader patches)
   *  and export it as a .glb Blob via GLTFExporter. Registered by TileGrid so
   *  the Leva panel can trigger a download without owning an exporter. */
  saveDiorama: (() => Promise<Blob | null>) | null
  /** Re-apply the current Leva state to uniforms + every mesh's count.
   *  Registered by GrassPanel, called by TileGrid after a hot-reload swap
   *  so density / flower split / colours / wind survive the scene rebuild. */
  reapplyControls: (() => void) | null
  /** Currently-loaded painted mask. Persists across hot-reload swaps so a
   *  glb rewrite doesn't drop back to AABB exclusion. Set by rebuildWithMask,
   *  cleared when rebuildWithMask(null) is called. loadGlbDiorama reads
   *  this and forwards it to buildGrass on every rebuild. */
  activeMask: ImageData | null
} = {
  mesh: null,
  maxCount: 0,
  meadowMeshes: [],
  meadowMax: { grass: 0, pink: 0, purple: 0, yellow: 0, red: 0 },
  captureTopView: null,
  rebuildWithMask: null,
  saveDiorama: null,
  reapplyControls: null,
  activeMask: null,
}

export interface GrassDebugData {
  halfW: number
  halfH: number
  blocks: { face: number; cx: number; cz: number; halfX: number; halfZ: number }[]
  exclusions: { xMin: number; xMax: number; zMin: number; zMax: number; owner: string }[]
  flatPositions: Float32Array
  stats: { candidates: number; allowed: number; excluded: number }
}
export const grassDebug: { data: GrassDebugData | null } = { data: null }

// ── Geometry helpers ───────────────────────────────────────────────────────

/** Tapered grass blade — two crossed quads. Narrow, procedural taper in shader. */
function buildBladeGeometry(width: number, height: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const w = width / 2
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const quads = [
    { ax: 1, az: 0, nx: 0, nz: 1 },
    { ax: 0, az: 1, nx: 1, nz: 0 },
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

// Flowers reuse the crossed-quad geometry but with a wider quad — the
// fragment shader discards sides of the stem portion and draws a blossom
// circle in the upper portion. Using the same geometry (and same vertex
// shader hook) keeps the wind bend identical between grass and flowers.

// ── Shader patches (shared vertex, per-kind fragment) ──────────────────────

const VERTEX_COMMON = /* glsl */`
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
`

const VERTEX_BEGIN = /* glsl */`
  vec3 transformed = vec3(position);
  vGrassUv = uv;
  vHue = iHue;

  vec3 instOrigin = vec3(instanceMatrix[3].xyz);
  vec3 worldWind3 = normalize(vec3(uWindDir.x, 0.0, uWindDir.y) + vec3(1e-4));

  float spatialPhase = dot(instOrigin, worldWind3) * uWaveScale;
  float wave = sin(uTime * uWindFreq - spatialPhase);
  float gust = sin(uTime * uWindFreq * 0.47 - spatialPhase * 0.63);
  float amp  = wave * 0.75 + gust * 0.25;

  mat3 iRot = mat3(
    normalize(instanceMatrix[0].xyz),
    normalize(instanceMatrix[1].xyz),
    normalize(instanceMatrix[2].xyz)
  );
  vec3 localWind = transpose(iRot) * worldWind3;
  vec2 bendDir2 = normalize(vec2(localWind.x, localWind.z) + vec2(1e-5));

  float theta = amp * uWindStrength * uBendAmount;
  float c = cos(theta);
  float s = sin(theta);
  float oc = 1.0 - c;
  vec3 k = vec3(bendDir2.y, 0.0, -bendDir2.x);

  vec3 p = vec3(position.x, position.y * uLengthScale, position.z);

  vec3 kxp = cross(k, p);
  float kdotp = dot(k, p);
  transformed = p * c + kxp * s + k * kdotp * oc;
`

const GRASS_FRAG_COMMON = /* glsl */`
  #include <common>
  varying float vHue;
  varying vec2  vGrassUv;
  uniform vec3  uBaseColor;
  uniform vec3  uTipColor;
  uniform float uHueJitter;
`

const GRASS_FRAG_MAP = /* glsl */`
  float ux     = abs(vGrassUv.x - 0.5) * 2.0;
  float taper  = mix(1.0, 0.18, vGrassUv.y);
  if (ux > taper) discard;
  vec3 gc = mix(uBaseColor, uTipColor, vGrassUv.y);
  gc *= 1.0 + (vHue - 0.5) * 2.0 * uHueJitter;
  diffuseColor.rgb *= gc;
`

const FLOWER_FRAG_COMMON = /* glsl */`
  #include <common>
  varying float vHue;
  varying vec2  vGrassUv;
  uniform vec3  uFlowerColor;
  uniform vec3  uStemColor;
  uniform float uHueJitter;
`

// Flower: thin stem along bottom 45% of uv.y, then a coloured blossom disc
// centred at (0.5, 0.75). Stem shares the grass stem colour; blossom gets
// per-flower-type uFlowerColor + a small per-instance hue jitter so a field
// of pinks isn't flat.
const FLOWER_FRAG_MAP = /* glsl */`
  float ux = abs(vGrassUv.x - 0.5) * 2.0;
  if (vGrassUv.y < 0.45) {
    if (ux > 0.18) discard;
    diffuseColor.rgb *= uStemColor;
  } else {
    vec2 d = vec2(ux, (vGrassUv.y - 0.75) * 3.2);
    if (dot(d, d) > 1.0) discard;
    vec3 fc = uFlowerColor;
    fc *= 1.0 + (vHue - 0.5) * 2.0 * uHueJitter;
    diffuseColor.rgb *= fc;
  }
`

function createGrassMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    transparent: false,
  })
  mat.onBeforeCompile = shader => {
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
      .replace('#include <common>', VERTEX_COMMON)
      .replace('#include <begin_vertex>', VERTEX_BEGIN)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', GRASS_FRAG_COMMON)
      .replace('#include <map_fragment>', GRASS_FRAG_MAP)
  }
  return mat
}

function createFlowerMaterial(color: { value: THREE.Color }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    transparent: false,
  })
  mat.onBeforeCompile = shader => {
    shader.uniforms.uTime         = grassUniforms.uTime
    shader.uniforms.uWindDir      = grassUniforms.uWindDir
    shader.uniforms.uWindStrength = grassUniforms.uWindStrength
    shader.uniforms.uWindFreq     = grassUniforms.uWindFreq
    shader.uniforms.uWaveScale    = grassUniforms.uWaveScale
    shader.uniforms.uBendAmount   = grassUniforms.uBendAmount
    shader.uniforms.uLengthScale  = grassUniforms.uLengthScale
    shader.uniforms.uHueJitter    = grassUniforms.uHueJitter
    shader.uniforms.uStemColor    = grassUniforms.uStemColor
    shader.uniforms.uFlowerColor  = color
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERTEX_COMMON)
      .replace('#include <begin_vertex>', VERTEX_BEGIN)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FLOWER_FRAG_COMMON)
      .replace('#include <map_fragment>', FLOWER_FRAG_MAP)
  }
  return mat
}

// ── Main builder ───────────────────────────────────────────────────────────

/** Returned by buildGrass when the diorama has no ground/terrain mesh.
 *  Same shape as a real GrassResult so callers (loadGlbDiorama, buildDiorama,
 *  TileGrid) never branch on presence — they always iterate `meshes` and
 *  call `update`/`dispose`. Publishes empty refs so the Leva panel's
 *  reapplyControls path is a no-op instead of throwing. */
function emptyGrassResult(): GrassResult {
  grassRefs.mesh = null
  grassRefs.maxCount = 0
  grassRefs.meadowMeshes = []
  grassRefs.meadowMax = { grass: 0, pink: 0, purple: 0, yellow: 0, red: 0 }
  grassDebug.data = null
  const stubGeom = new THREE.BufferGeometry()
  const stubMat = new THREE.MeshBasicMaterial()
  const stub = (name: string) => {
    const m = new THREE.InstancedMesh(stubGeom, stubMat, 0)
    m.name = name
    m.visible = false
    return m
  }
  const grass = stub('grass')
  const flowers: Record<FlowerKey, THREE.InstancedMesh> = {
    pink:   stub('flower-pink'),
    purple: stub('flower-purple'),
    yellow: stub('flower-yellow'),
    red:    stub('flower-red'),
  }
  return {
    grass,
    flowers,
    meshes: [], // deliberately empty so callers don't add invisible stubs to the scene
    uniforms: grassUniforms,
    update: () => {},
    dispose: () => { stubGeom.dispose(); stubMat.dispose() },
    stats: {
      candidates: 0,
      allowed: 0,
      excluded: 0,
      perBucket: { grass: 0, pink: 0, purple: 0, yellow: 0, red: 0 },
    },
  }
}

export function buildGrass(dioramaRoot: THREE.Object3D, opts: GrassOpts = {}): GrassResult {
  const {
    densityPerUnit2 = 20000,
    exclusionMargin = 0.05,
    bladeHeight     = 0.015,
    bladeWidth      = 0.003,
    flowerHeight    = 0.020,
    flowerWidth     = 0.018,
    excludeNames    = DEFAULT_EXCLUDE,
    groundOffset    = 0.0005,
    maskImage       = null,
    maskThreshold   = 128,
  } = opts

  const MASK_HALF_W = 4
  const MASK_HALF_H = 3

  // Step 0 — locate the ground. Grass emits from the XZ AABB of the first
  // mesh whose name starts with "ground" or "terrain" (Blender exports add
  // ".001" suffixes — startsWith handles both). No ground found ⇒ the
  // diorama's author hasn't declared a meadow surface; log and skip.
  //
  // Every scene-space query below (setFromObject, applyMatrix4) reads
  // ascending matrixWorld, so the diorama root's CURRENT matrix contaminates
  // the results. On the initial build the root is a fresh Group (identity);
  // on rebuildWithMask it's been mutated mid-frame by TileGrid's 24-pass
  // per-cell transforms (root.position/quaternion is overwritten every
  // pass — see TileGrid.tsx:1075-1078, 1092-1095). If we don't neutralize
  // it, the ground AABB comes back in cube-space for one random cell,
  // the triangle positions are pre-transformed to that same cube, and all
  // downstream math is silently wrong — symptom: loadMask "doesn't work"
  // because only a narrow sliver of candidates survive sampleGroundAt.
  // Save/reset/restore so the build always runs in root-local space.
  const _prevRootMatrix = dioramaRoot.matrix.clone()
  const _prevRootMatrixAutoUpdate = dioramaRoot.matrixAutoUpdate
  const _prevRootPosition = dioramaRoot.position.clone()
  const _prevRootQuaternion = dioramaRoot.quaternion.clone()
  const _prevRootScale = dioramaRoot.scale.clone()
  dioramaRoot.position.set(0, 0, 0)
  dioramaRoot.quaternion.identity()
  dioramaRoot.scale.set(1, 1, 1)
  dioramaRoot.matrix.identity()
  dioramaRoot.matrixAutoUpdate = false
  dioramaRoot.updateMatrixWorld(true)
  const restoreRoot = () => {
    dioramaRoot.position.copy(_prevRootPosition)
    dioramaRoot.quaternion.copy(_prevRootQuaternion)
    dioramaRoot.scale.copy(_prevRootScale)
    dioramaRoot.matrix.copy(_prevRootMatrix)
    dioramaRoot.matrixAutoUpdate = _prevRootMatrixAutoUpdate
    dioramaRoot.updateMatrixWorld(true)
  }
  let groundMesh: THREE.Mesh | null = null
  dioramaRoot.traverse(obj => {
    if (groundMesh) return
    const m = obj as THREE.Mesh
    if (!m.isMesh) return
    const n = (m.name || '').toLowerCase()
    if (GROUND_NAME_PREFIXES.some(p => n.startsWith(p))) groundMesh = m
  })
  if (!groundMesh) {
    // eslint-disable-next-line no-console
    console.error('[grass] no ground object is found — add a mesh named "ground" (or "terrain") to the diorama. Skipping grass.')
    restoreRoot()
    return emptyGrassResult()
  }
  const groundBox = new THREE.Box3().setFromObject(groundMesh)
  const groundMin = groundBox.min
  const groundMax = groundBox.max
  const groundCx = (groundMin.x + groundMax.x) * 0.5
  const groundCz = (groundMin.z + groundMax.z) * 0.5
  const groundHalfX = (groundMax.x - groundMin.x) * 0.5
  const groundHalfZ = (groundMax.z - groundMin.z) * 0.5
  const groundArea = (groundMax.x - groundMin.x) * (groundMax.z - groundMin.z)
  if (!isFinite(groundArea) || groundArea <= 0) {
    // eslint-disable-next-line no-console
    console.error('[grass] ground AABB is degenerate — skipping grass.', { name: (groundMesh as THREE.Mesh).name, groundMin, groundMax })
    restoreRoot()
    return emptyGrassResult()
  }

  // Step 0b — build a CPU height/normal sampler from the ground geometry so
  // each blade sits on the actual sculpted surface (not a flat plane at
  // groundOffset). World-space triangles are binned into a coarse XZ grid
  // once at build; per-candidate lookup is O(k) in the few triangles whose
  // XZ bbox overlaps the query cell. Barycentric check in the XZ plane
  // rejects cells that land outside any triangle (island-shaped grounds,
  // holes). One-time cost; zero per-frame cost.
  type GroundSample = { y: number; normal: THREE.Vector3; density: number }
  const groundTris: {
    ax: number; ay: number; az: number
    bx: number; by: number; bz: number
    cx: number; cy: number; cz: number
    xMin: number; xMax: number; zMin: number; zMax: number
    nx: number; ny: number; nz: number
    // Vertex-color R channel per corner (0..1). If the ground has no
    // COLOR_0 attribute, all three default to 1 so sample.density === 1.
    rA: number; rB: number; rC: number
  }[] = []
  {
    const gm = groundMesh as THREE.Mesh
    const geom = gm.geometry
    const posAttr = geom.attributes.position as THREE.BufferAttribute | undefined
    if (!posAttr) {
      // eslint-disable-next-line no-console
      console.error('[grass] ground mesh has no position attribute — skipping grass.', gm.name)
      restoreRoot()
      return emptyGrassResult()
    }
    const indexAttr = geom.index as THREE.BufferAttribute | null
    // Optional vertex-color attribute painted in Blender (Vertex Paint mode).
    // R channel = density in [0, 1]. Missing ⇒ density fixed at 1 (allow-all),
    // preserving current behaviour for un-painted grounds. glTF / three.js
    // standardises the name `color`; three.js's GLTFLoader auto-populates it
    // from the glTF `COLOR_0` attribute.
    const colorAttr = geom.attributes.color as THREE.BufferAttribute | undefined
    const world = gm.matrixWorld
    const vA = new THREE.Vector3()
    const vB = new THREE.Vector3()
    const vC = new THREE.Vector3()
    const e1 = new THREE.Vector3()
    const e2 = new THREE.Vector3()
    const nrm = new THREE.Vector3()
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3
    for (let t = 0; t < triCount; t++) {
      const ia = indexAttr ? indexAttr.getX(t * 3)     : t * 3
      const ib = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1
      const ic = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2
      vA.fromBufferAttribute(posAttr, ia).applyMatrix4(world)
      vB.fromBufferAttribute(posAttr, ib).applyMatrix4(world)
      vC.fromBufferAttribute(posAttr, ic).applyMatrix4(world)
      e1.subVectors(vB, vA)
      e2.subVectors(vC, vA)
      nrm.crossVectors(e1, e2)
      if (nrm.lengthSq() < 1e-20) continue  // degenerate tri
      nrm.normalize()
      const rA = colorAttr ? colorAttr.getX(ia) : 1
      const rB = colorAttr ? colorAttr.getX(ib) : 1
      const rC = colorAttr ? colorAttr.getX(ic) : 1
      groundTris.push({
        ax: vA.x, ay: vA.y, az: vA.z,
        bx: vB.x, by: vB.y, bz: vB.z,
        cx: vC.x, cy: vC.y, cz: vC.z,
        xMin: Math.min(vA.x, vB.x, vC.x),
        xMax: Math.max(vA.x, vB.x, vC.x),
        zMin: Math.min(vA.z, vB.z, vC.z),
        zMax: Math.max(vA.z, vB.z, vC.z),
        nx: nrm.x, ny: nrm.y, nz: nrm.z,
        rA, rB, rC,
      })
    }
  }
  if (groundTris.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[grass] ground mesh has no valid triangles — skipping grass.', (groundMesh as THREE.Mesh).name)
    restoreRoot()
    return emptyGrassResult()
  }
  // Grid sized so each cell holds a handful of tris on average. ~80×60 gives
  // cell ≈ 0.1 world units on the 8×6 net, fine for terrain with thousands
  // of tris. Scales with ground size because cellW/cellH are derived, not fixed.
  const GRID_COLS = 80
  const GRID_ROWS = 60
  const gridCellW = (groundMax.x - groundMin.x) / GRID_COLS
  const gridCellH = (groundMax.z - groundMin.z) / GRID_ROWS
  const groundCells: number[][] = Array.from({ length: GRID_COLS * GRID_ROWS }, () => [])
  for (let ti = 0; ti < groundTris.length; ti++) {
    const tri = groundTris[ti]
    const c0 = Math.max(0, Math.min(GRID_COLS - 1, Math.floor((tri.xMin - groundMin.x) / gridCellW)))
    const c1 = Math.max(0, Math.min(GRID_COLS - 1, Math.floor((tri.xMax - groundMin.x) / gridCellW)))
    const r0 = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor((tri.zMin - groundMin.z) / gridCellH)))
    const r1 = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor((tri.zMax - groundMin.z) / gridCellH)))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        groundCells[r * GRID_COLS + c].push(ti)
      }
    }
  }
  const sampleGroundAt = (x: number, z: number): GroundSample | null => {
    const c = Math.floor((x - groundMin.x) / gridCellW)
    const r = Math.floor((z - groundMin.z) / gridCellH)
    if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) return null
    const list = groundCells[r * GRID_COLS + c]
    for (let i = 0; i < list.length; i++) {
      const tri = groundTris[list[i]]
      // Barycentric containment in the XZ plane.
      const v0x = tri.bx - tri.ax, v0z = tri.bz - tri.az
      const v1x = tri.cx - tri.ax, v1z = tri.cz - tri.az
      const v2x = x - tri.ax,       v2z = z - tri.az
      const d00 = v0x * v0x + v0z * v0z
      const d01 = v0x * v1x + v0z * v1z
      const d11 = v1x * v1x + v1z * v1z
      const d20 = v2x * v0x + v2z * v0z
      const d21 = v2x * v1x + v2z * v1z
      const denom = d00 * d11 - d01 * d01
      if (denom === 0) continue
      const v = (d11 * d20 - d01 * d21) / denom
      const w = (d00 * d21 - d01 * d20) / denom
      const u = 1 - v - w
      const eps = 1e-6
      if (u < -eps || v < -eps || w < -eps) continue
      const y = u * tri.ay + v * tri.by + w * tri.cy
      const density = u * tri.rA + v * tri.rB + w * tri.rC
      return { y, normal: new THREE.Vector3(tri.nx, tri.ny, tri.nz), density }
    }
    return null
  }

  // Step 1 — exclusion rects (skipped if a painted mask is in use).
  type Rect = { xMin: number; xMax: number; zMin: number; zMax: number; owner: string }
  const exclusions: Rect[] = []
  const _box = new THREE.Box3()
  if (!maskImage) {
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
  }

  const maskW = maskImage?.width ?? 0
  const maskH = maskImage?.height ?? 0
  const maskData = maskImage?.data
  const allowedByMask = (flatX: number, flatZ: number): boolean => {
    if (!maskData) return true
    const u = (flatX + MASK_HALF_W) / (MASK_HALF_W * 2)
    const v = (flatZ + MASK_HALF_H) / (MASK_HALF_H * 2)
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false
    const px = Math.min(maskW - 1, Math.floor(u * maskW))
    const py = Math.min(maskH - 1, Math.floor(v * maskH))
    const i = (py * maskW + px) * 4
    const lum = (maskData[i] + maskData[i + 1] + maskData[i + 2]) / 3
    return lum > maskThreshold
  }

  // Step 2 — sample candidates + classify each into one of 5 buckets. Even
  // split at BUILD time (each bucket gets 1/5 of survivors on average). The
  // Leva panel then controls per-bucket visible count independently, so the
  // flower-% and per-colour-weight sliders just scale each mesh.count.
  type Per = {
    positions: THREE.Vector3[]
    positions2D: THREE.Vector2[]
    normals: THREE.Vector3[]
    hues: number[]
    yaws: number[]
    scales: number[]
  }
  const emptyPer = (): Per => ({ positions: [], positions2D: [], normals: [], hues: [], yaws: [], scales: [] })
  const per: Record<Bucket, Per> = {
    grass:  emptyPer(),
    pink:   emptyPer(),
    purple: emptyPer(),
    yellow: emptyPer(),
    red:    emptyPer(),
  }

  // Budget candidates by the ground's area so density reads as "per unit²"
  // regardless of the authored ground size (an island-shaped ground with a
  // smaller AABB gets proportionally fewer candidates than the full 8×6 net).
  const totalCandidates = Math.max(1, Math.floor(densityPerUnit2 * groundArea))
  let excluded = 0
  const debugFlat: number[] = []
  const groundWidth  = groundMax.x - groundMin.x
  const groundDepth  = groundMax.z - groundMin.z

  for (let i = 0; i < totalCandidates; i++) {
    const flatX = groundMin.x + Math.random() * groundWidth
    const flatZ = groundMin.z + Math.random() * groundDepth
    if (maskImage) {
      if (!allowedByMask(flatX, flatZ)) { excluded++; continue }
    } else {
      let inside = false
      for (const r of exclusions) {
        if (flatX >= r.xMin && flatX <= r.xMax && flatZ >= r.zMin && flatZ <= r.zMax) {
          inside = true; break
        }
      }
      if (inside) { excluded++; continue }
    }
    // Lift the candidate onto the actual ground surface. Miss ⇒ candidate
    // sits over a hole/gap in the ground geometry; treat as excluded so the
    // meadow stays strictly surface-bound.
    const sample = sampleGroundAt(flatX, flatZ)
    if (!sample) { excluded++; continue }
    // Vertex-color density gate. Composes WITH exclusions (both must allow).
    // When the ground has no COLOR_0 attribute, sample.density === 1 and
    // this is a no-op. When the user has painted the ground in Blender's
    // Vertex Paint mode, the R channel acts as a per-candidate probability:
    // white=always keep, black=always reject, grey=proportional.
    if (sample.density < 1 && Math.random() > sample.density) { excluded++; continue }
    // Even 20% split across buckets.
    const bucketIdx = Math.min(4, Math.floor(Math.random() * 5))
    const bucket = BUCKETS[bucketIdx]
    const bp = per[bucket]
    bp.positions.push(new THREE.Vector3(flatX, sample.y + groundOffset, flatZ))
    bp.positions2D.push(new THREE.Vector2(flatX, flatZ))
    bp.normals.push(sample.normal)
    bp.hues.push(Math.random())
    bp.yaws.push(Math.random() * Math.PI * 2)
    bp.scales.push(0.75 + Math.random() * 0.5)
    debugFlat.push(flatX, flatZ)
  }

  const allowedTotal =
    per.grass.positions.length + per.pink.positions.length + per.purple.positions.length +
    per.yellow.positions.length + per.red.positions.length

  // Step 3 — build five meshes via a helper. Each bucket gets its own shuffle
  // so per-mesh density scaling thins uniformly across the whole net within
  // that bucket.
  function buildBucketMesh(bucket: Bucket): { mesh: THREE.InstancedMesh; max: number } {
    const bp = per[bucket]
    const n = bp.positions.length
    const perm: number[] = []
    for (let i = 0; i < n; i++) perm.push(i)
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t
    }
    const shuffledHues = new Float32Array(n)
    for (let i = 0; i < n; i++) shuffledHues[i] = bp.hues[perm[i]]

    const isGrass = bucket === 'grass'
    const geom = isGrass
      ? buildBladeGeometry(bladeWidth, bladeHeight)
      : buildBladeGeometry(flowerWidth, flowerHeight)
    geom.setAttribute('iHue', new THREE.InstancedBufferAttribute(shuffledHues, 1))

    const material = isGrass
      ? createGrassMaterial()
      : createFlowerMaterial(flowerColorUniforms[bucket])

    const mesh = new THREE.InstancedMesh(geom, material, Math.max(1, n))
    mesh.name = isGrass ? 'grass' : `flower-${bucket}`
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.raycast = () => {}

    // Blade frame: +Y aligned with the ground's world normal at the blade
    // root, then yaw around that normal. On a flat ground normal=(0,1,0)
    // this reduces to the old setFromAxisAngle(+Y, yaw) path; on a sculpted
    // slope it tilts the blade so it grows OUT of the surface, not out of
    // world-up. Wind bending stays consistent because the vertex shader
    // derives the bend direction from `transpose(iRot) * worldWind` — any
    // instance basis, tilted or not, maps world wind into the blade's local
    // frame correctly.
    const _mat   = new THREE.Matrix4()
    const _q     = new THREE.Quaternion()
    const _scale = new THREE.Vector3()
    const _basis = new THREE.Matrix4()
    const _up    = new THREE.Vector3()
    const _ref   = new THREE.Vector3()
    const _right0 = new THREE.Vector3()
    const _fwd0   = new THREE.Vector3()
    const _right  = new THREE.Vector3()
    const _fwd    = new THREE.Vector3()
    const WORLD_X = new THREE.Vector3(1, 0, 0)
    const WORLD_Z = new THREE.Vector3(0, 0, 1)
    for (let i = 0; i < n; i++) {
      const src = perm[i]
      _up.copy(bp.normals[src])
      // Pick a reference axis that isn't parallel to the normal.
      _ref.copy(Math.abs(_up.y) > 0.99 ? WORLD_X : WORLD_Z)
      _right0.crossVectors(_ref, _up).normalize()
      _fwd0.crossVectors(_up, _right0)  // already unit since both orthonormal
      const yaw = bp.yaws[src]
      const cy = Math.cos(yaw)
      const sy = Math.sin(yaw)
      _right.copy(_right0).multiplyScalar(cy).addScaledVector(_fwd0, sy)
      _fwd.crossVectors(_up, _right)
      _basis.makeBasis(_right, _up, _fwd)
      _q.setFromRotationMatrix(_basis)
      const s = bp.scales[src]
      _scale.set(s, s, s)
      _mat.compose(bp.positions[src], _q, _scale)
      mesh.setMatrixAt(i, _mat)
    }
    mesh.instanceMatrix.needsUpdate = true
    // Initial visible count: grass ~50% of its max so the planet reads green
    // by default; flowers 25% so there are visible blossoms without the field
    // being drowned in colour.
    mesh.count = Math.floor(n * (isGrass ? 0.5 : 0.25))
    return { mesh, max: n }
  }

  const built: Record<Bucket, { mesh: THREE.InstancedMesh; max: number }> = {
    grass:  buildBucketMesh('grass'),
    pink:   buildBucketMesh('pink'),
    purple: buildBucketMesh('purple'),
    yellow: buildBucketMesh('yellow'),
    red:    buildBucketMesh('red'),
  }

  const meshes = BUCKETS.map(b => built[b].mesh)
  const maxPerBucket: Record<Bucket, number> = {
    grass:  built.grass.max,
    pink:   built.pink.max,
    purple: built.purple.max,
    yellow: built.yellow.max,
    red:    built.red.max,
  }

  // Publish refs.
  grassRefs.mesh        = built.grass.mesh
  grassRefs.maxCount    = built.grass.max
  grassRefs.meadowMeshes = meshes
  grassRefs.meadowMax   = maxPerBucket

  // Density-map debug data. `halfW/halfH = 4/3` stays pinned to the mask's
  // flat-space frame (independent of ground size) so painted masks keep
  // their coordinates; the single block entry describes the actual ground
  // rect the panel draws as the allowed region.
  const flatArr = new Float32Array(debugFlat)
  grassDebug.data = {
    halfW: 4,
    halfH: 3,
    blocks: [{ face: -1, cx: groundCx, cz: groundCz, halfX: groundHalfX, halfZ: groundHalfZ }],
    exclusions: exclusions.map(e => ({ ...e })),
    flatPositions: flatArr,
    stats: { candidates: totalCandidates, allowed: allowedTotal, excluded },
  }
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__grass = {
      mesh: built.grass.mesh,
      meshes,
      uniforms: grassUniforms,
      flowerColors: flowerColorUniforms,
      refs: grassRefs,
    }
  }

  const update = (elapsed: number) => {
    grassUniforms.uTime.value = elapsed
  }

  const dispose = () => {
    for (const b of BUCKETS) {
      built[b].mesh.geometry.dispose()
      const m = built[b].mesh.material
      if (Array.isArray(m)) m.forEach(x => x.dispose())
      else m.dispose()
    }
    if (grassRefs.mesh === built.grass.mesh) {
      grassRefs.mesh = null
      grassRefs.maxCount = 0
      grassRefs.meadowMeshes = []
      grassRefs.meadowMax = { grass: 0, pink: 0, purple: 0, yellow: 0, red: 0 }
    }
  }

  restoreRoot()

  return {
    grass:   built.grass.mesh,
    flowers: { pink: built.pink.mesh, purple: built.purple.mesh, yellow: built.yellow.mesh, red: built.red.mesh },
    meshes,
    uniforms: grassUniforms,
    update,
    dispose,
    stats: {
      candidates: totalCandidates,
      allowed: allowedTotal,
      excluded,
      perBucket: {
        grass:  built.grass.max,
        pink:   built.pink.max,
        purple: built.purple.max,
        yellow: built.yellow.max,
        red:    built.red.max,
      },
    },
  }
}
