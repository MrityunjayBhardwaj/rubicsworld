/**
 * Split / Cube tile rendering using 3D clip planes.
 *
 * 'split': 24 cells on the flat XZ plane with gaps, clip boxes vertical.
 * 'cube':  24 cells folded onto cube faces, clip boxes rotated to face.
 *
 * ONE diorama — rendered 24 times with different clip planes + transform.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useFBO } from '@react-three/drei'
import { buildDiorama, buildSphereTerrain, fresnelUniform, sliceRotUniforms, hudUniforms, HALF_W, HALF_H, type DioramaScene } from './buildDiorama'
import { grassUniforms, GRASS_TRAIL_N } from './buildGrass'

// Grass hover-trail ring buffer state. Module-scoped because there's a
// single TileGrid mounting the scene; state must persist across frames.
// Stamp cadence: every 20 ms OR when cursor moves ≥ 8 mm since last stamp.
// With 32 slots these values give ~0.64 s of trail history, comfortably
// longer than the 0.5 s default decay so the ring never "runs out".
let grassTrailIdx = 0
let grassTrailLastT = -1
let grassTrailLastX = 1e9
let grassTrailLastY = 1e9
let grassTrailLastZ = 1e9
const GRASS_STAMP_MIN_INTERVAL = 0.02
const GRASS_STAMP_MIN_DIST = 0.008
// Smoothed grass-swipe intensity for the audio loop. Writes from the
// stamp loop where stampActive + dd are already in scope.
let grassSwipeSmooth = 0

// /optimize/ route scratch — module-scoped so the cull path doesn't
// allocate per frame. Only read/written from inside useFrame.
const optFrustumInst = new THREE.Frustum()
const optVec3a = new THREE.Vector3()
const optMat4 = new THREE.Matrix4()
const optSphere = new THREE.Sphere()
let optLogLast = 0
import { buildGrass, grassRefs } from './buildGrass'
import { loadGlbDiorama } from './loadGlbDiorama'
import { audioBus } from '../world/audio/bus'
import { buildSphereVisibility, applySphereVisibility, restoreSphereVisibility, type SphereVisibility } from './sphereVisibility'

// Register named diorama groups as audio anchors so PositionalAudio nodes
// follow car / windmill / bird-flock through space. Idempotent — running
// twice just overwrites the same key. Called after each diorama (re)build.
function registerDioramaAudioAnchors(root: THREE.Object3D) {
  // Wire the diorama root for the bus's sphere-projection reset trick.
  // Audio anchors live in dScene's flat cube-net space; the bus needs the
  // root reference so it can momentarily zero the per-tile transform when
  // reading source positions each frame.
  audioBus.setDioramaRoot(root)
  const car = root.getObjectByName('car')
  const windmill = root.getObjectByName('windmill')
  const birds = root.getObjectByName('birds')
  const pond = root.getObjectByName('pond')
  // Each group gets a centre-of-mass child Object3D so audio + visualiser
  // sphere attach at the visual middle (Box3 centre) instead of the group's
  // local (0,0,0). For the windmill the local origin is at the foot of the
  // tower; for the car it's below the wheels; correcting those matters.
  if (car) audioBus.registerAnchorAtCenter('car', car)
  if (windmill) audioBus.registerAnchorAtCenter('windmill', windmill)
  if (pond) audioBus.registerAnchorAtCenter('pond', pond)
  // birds_group stays as-is — it's the parent for the boids centroid loop
  // (each frame AudioBus.tsx writes the centroid to a child source which the
  // bus then sphere-projects).
  if (birds) audioBus.registerAnchor('birds_group', birds)
}
function unregisterDioramaAudioAnchors() {
  audioBus.unregisterAnchor('car')
  audioBus.unregisterAnchor('windmill')
  audioBus.unregisterAnchor('birds_group')
  audioBus.unregisterAnchor('birds_flock')
  audioBus.unregisterAnchor('pond')
  audioBus.setDioramaRoot(null)
}
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { COLS, ROWS, CELL, cellFace, FACE_TO_BLOCK_TL } from './DioramaGrid'
import { FACES, type FaceIndex } from '../world/faces'
import { usePlanet } from '../world/store'
import { AXIS_VEC, tileInSlice, NEIGHBOR_IDX, type Axis } from '../world/rotation'
import { useHdri } from '../world/hdriStore'
import type { Tile } from '../world/tile'

const SLICE_ROT_MS = 380

// Scratch buffer for the per-frame edge-mask recompute. Module-scoped so we
// don't allocate 24 ints per frame. 24 slots, one per current tile position.
const _atHomeScratch = new Uint8Array(24)

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Hide the flat "terrain" plane in sphere mode.
 *  Context: buildGrass (PV11) finds its sampling surface by traversing the
 *  diorama root for a mesh whose name starts with "ground"/"terrain". In
 *  sphere mode we render a separate global sphere-terrain mesh; the flat
 *  plane would double-draw. Keep it present but invisible: traverse still
 *  visits it (grass can build its AABB from the geometry), three.js skips
 *  rendering invisible meshes. */
function hideFlatTerrainInSphereMode(root: THREE.Object3D, mode: TileMode) {
  if (mode !== 'sphere') return
  root.traverse(obj => {
    const m = obj as THREE.Mesh
    if (m.isMesh && m.name === 'terrain') m.visible = false
  })
}

export type TileMode = 'split' | 'cube' | 'sphere'

// ── Cell definitions ─────────────────────────────────────────────────

const SPLIT_GAP = 0.12
const CUBE_GAP = 0.06
const SPHERE_GAP = 0.0 // no gap on the planet — seamless

interface CellDef {
  col: number
  row: number
  face: number
  localU: number // 0 or 1 within the face's 2×2 block
  localV: number
  homeX: number  // center in flat diorama space
  homeZ: number
}

// Face index → (col, row) top-left of its 2×2 block on the cross cube-net.
// Uses the mapping exported by DioramaGrid so the flat diorama content and
// the sphere renderer agree on every home cell.

/** Convert store tile home position to grid (col, row) → diorama homeX/homeZ.
 *  Sphere/cube parity: cube view puts lower flat row content at the physical
 *  top of each face (see cubeCellRender's row swap). Mirror that here so the
 *  sphere renders the same content at each physical position as cube view —
 *  tile with v=0 (physical top under the v-flip convention) now pulls content
 *  from flat row = blockRow, matching the cube view's localV = 1 mapping. */
function tileToHome(homeFace: FaceIndex, homeU: number, homeV: number) {
  const [blockCol, blockRow] = FACE_TO_BLOCK_TL[homeFace]
  const col = blockCol + homeU
  const row = blockRow + homeV
  return {
    col, row,
    homeX: -HALF_W + (col + 0.5) * CELL,
    homeZ: -HALF_H + (row + 0.5) * CELL,
  }
}

/** Compute CellRender for a store tile at its CURRENT position, showing its HOME content */
function storeTileCubeRender(tile: Tile, gap: number): CellRender {
  const home = tileToHome(tile.homeFace, tile.homeU, tile.homeV)
  const currentFace = FACES[tile.face]
  const halfCell = (CELL - gap) / 2

  // Current position on cube
  const localU = tile.u
  const localV = tile.v
  const uOff = (localU - 0.5) * CELL
  const vOff = (0.5 - localV) * CELL
  const cubePos = currentFace.normal.clone()
    .addScaledVector(currentFace.right, uOff)
    .addScaledVector(currentFace.up, vOff)

  // Root rotation = tile.orientation · faceQuaternion(homeFace). orientation
  // is the cumulative world-space rotation applied to this tile since the
  // solved state, so this composes to the same value the animated path
  // produces at anim-end — no pop on commit. At identity orientation (solved
  // home tile, homeFace == currentFace) it reduces to faceQuaternion(currentFace).
  const faceQuat = tile.orientation.clone()
    .multiply(faceQuaternion(FACES[tile.homeFace]))

  // Position: align HOME content with CURRENT cube position
  const homeOffset = new THREE.Vector3(-home.homeX, 0, -home.homeZ)
  homeOffset.applyQuaternion(faceQuat)
  const position = cubePos.clone().add(homeOffset)

  // Clip planes at current position (8 planes: 4 within-face + 4 face-boundary)
  const rDot = currentFace.right.dot(cubePos)
  const uDot = currentFace.up.dot(cubePos)
  const n = currentFace.normal
  const r = currentFace.right
  const u = currentFace.up

  // Face-boundary planes get a small positive constant (EDGE_OVERDRAW) so
  // adjacent face passes overlap by a sub-pixel sliver at cube edges. With
  // constant 0, the two passes meet mathematically but float precision in
  // their per-cell transforms lands the same source vertex on slightly
  // different sphere points each pass — neither covers the boundary
  // pixel → hairline of sky shows through. A tiny positive constant turns
  // the neither-side miss into an overdraw; cost is invisible, gap is gone.
  const EDGE_OVERDRAW = 1e-3
  const clipPlanes = [
    new THREE.Plane(r.clone(), halfCell - rDot),
    new THREE.Plane(r.clone().negate(), halfCell + rDot),
    new THREE.Plane(u.clone(), halfCell - uDot),
    new THREE.Plane(u.clone().negate(), halfCell + uDot),
    new THREE.Plane(n.clone().sub(r.clone()).normalize(), EDGE_OVERDRAW),
    new THREE.Plane(n.clone().add(r.clone()).normalize(), EDGE_OVERDRAW),
    new THREE.Plane(n.clone().sub(u.clone()).normalize(), EDGE_OVERDRAW),
    new THREE.Plane(n.clone().add(u.clone()).normalize(), EDGE_OVERDRAW),
  ]

  return { position, quaternion: faceQuat, clipPlanes }
}

function buildCellDefs(): CellDef[] {
  // Only iterate filled cells on the cross cube-net (24 cells).
  const cells: CellDef[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const face = cellFace(col, row)
      if (face < 0) continue
      cells.push({
        col, row,
        face,
        localU: col % 2,
        // v=0 is physical top of face; in the cross net, upper flat rows
        // map to cube top after the fold, so flip row%2.
        localV: 1 - (row % 2),
        homeX: -HALF_W + (col + 0.5) * CELL,
        homeZ: -HALF_H + (row + 0.5) * CELL,
      })
    }
  }
  return cells
}

// ── Per-mode cell transform + clip planes ────────────────────────────

interface CellRender {
  /** Diorama root position */
  position: THREE.Vector3
  /** Diorama root quaternion */
  quaternion: THREE.Quaternion
  /** World-space clip planes (4 planes forming a 3D box) */
  clipPlanes: THREE.Plane[]
}

function flatCellRender(cell: CellDef, gap: number): CellRender {
  const gapX = (cell.col - (COLS - 1) / 2) * gap
  const gapZ = (cell.row - (ROWS - 1) / 2) * gap
  const splitX = cell.homeX + gapX
  const splitZ = cell.homeZ + gapZ
  const halfCell = (CELL - gap) / 2

  return {
    position: new THREE.Vector3(splitX - cell.homeX, 0, splitZ - cell.homeZ),
    quaternion: new THREE.Quaternion(), // identity
    clipPlanes: [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -(splitX - halfCell)),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), splitX + halfCell),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -(splitZ - halfCell)),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), splitZ + halfCell),
    ],
  }
}

/**
 * Build a proper rotation quaternion that maps:
 *   flat X → face.right
 *   flat Y → face.normal (height becomes outward)
 *   flat Z → derived (cross product to keep right-handed)
 */
function faceQuaternion(face: typeof FACES[number]): THREE.Quaternion {
  // Step 1: rotate flat Y (0,1,0) to face normal
  const q1 = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    face.normal.clone(),
  )
  // Step 2: after q1, find where flat X ended up, then rotate around
  // the normal to align it with face.right
  const rotatedX = new THREE.Vector3(1, 0, 0).applyQuaternion(q1)
  const angle = Math.atan2(
    rotatedX.clone().cross(face.right).dot(face.normal),
    rotatedX.dot(face.right),
  )
  const q2 = new THREE.Quaternion().setFromAxisAngle(face.normal, angle)
  return q2.multiply(q1)
}

function cubeCellRender(cell: CellDef, gap: number): CellRender {
  const face = FACES[cell.face]
  const halfCell = (CELL - gap) / 2

  // Cell center on cube face.
  // Cube view uses the raw row-parity for v (not the globally-flipped
  // convention) so each folded face's rows read the same as in the net:
  // lower flat row at physical top, upper flat row at bottom. This is the
  // user-requested "swap rows in each face" for the cube view.
  const uOff = (cell.localU - 0.5) * CELL
  const vOff = (cell.localV - 0.5) * CELL
  const cubePos = face.normal.clone()
    .addScaledVector(face.right, uOff)
    .addScaledVector(face.up, vOff)

  // Proper rotation quaternion
  const faceQuat = faceQuaternion(face)

  // Position: cubePos + rotation applied to (-homeX, 0, -homeZ)
  const homeOffset = new THREE.Vector3(-cell.homeX, 0, -cell.homeZ)
  homeOffset.applyQuaternion(faceQuat)
  const position = cubePos.clone().add(homeOffset)

  // Clip planes in world space, oriented to the face
  const rDot = face.right.dot(cubePos)
  const uDot = face.up.dot(cubePos)

  const n = face.normal
  const r = face.right
  const u = face.up

  const clipPlanes = [
    // Within-face: isolate this tile's quadrant
    new THREE.Plane(r.clone(), halfCell - rDot),
    new THREE.Plane(r.clone().negate(), halfCell + rDot),
    new THREE.Plane(u.clone(), halfCell - uDot),
    new THREE.Plane(u.clone().negate(), halfCell + uDot),
    // Face-boundary: restrict to this face (normal component must be dominant)
    // N·p >= R·p → (N-R)·p >= 0, etc.
    new THREE.Plane(n.clone().sub(r.clone()).normalize(), 0),
    new THREE.Plane(n.clone().add(r.clone()).normalize(), 0),
    new THREE.Plane(n.clone().sub(u.clone()).normalize(), 0),
    new THREE.Plane(n.clone().add(u.clone()).normalize(), 0),
  ]

  return { position, quaternion: faceQuat, clipPlanes }
}

// ── Grid lines ───────────────────────────────────────────────────────

function buildOverlayLines(cells: CellDef[], mode: TileMode): THREE.LineSegments {
  const pts: number[] = []
  const gap = mode === 'cube' ? CUBE_GAP : SPLIT_GAP

  for (const cell of cells) {
    const face = FACES[cell.face]
    const halfCell = (CELL - gap) / 2

    if (mode === 'cube' || mode === 'sphere') {
      const uOff = (cell.localU - 0.5) * CELL
      // Cube overlay uses row-swapped vOff so gridlines line up with the
      // rotated cubeCellRender placement; sphere overlay (unused) would use
      // the global convention.
      const vOff = mode === 'cube'
        ? (cell.localV - 0.5) * CELL
        : (0.5 - cell.localV) * CELL
      const center = face.normal.clone()
        .addScaledVector(face.right, uOff)
        .addScaledVector(face.up, vOff)
      if (mode === 'sphere') center.normalize()

      const corners = [
        face.normal.clone().addScaledVector(face.right, uOff - halfCell).addScaledVector(face.up, vOff - halfCell),
        face.normal.clone().addScaledVector(face.right, uOff + halfCell).addScaledVector(face.up, vOff - halfCell),
        face.normal.clone().addScaledVector(face.right, uOff + halfCell).addScaledVector(face.up, vOff + halfCell),
        face.normal.clone().addScaledVector(face.right, uOff - halfCell).addScaledVector(face.up, vOff + halfCell),
      ]
      if (mode === 'sphere') for (const c of corners) c.normalize()
      // Offset slightly along normal to avoid z-fighting
      const norm = mode === 'sphere' ? center.clone() : face.normal.clone()
      for (const c of corners) c.addScaledVector(norm, 0.005)

      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4]
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    } else {
      const gapX = (cell.col - (COLS - 1) / 2) * gap
      const gapZ = (cell.row - (ROWS - 1) / 2) * gap
      const cx = cell.homeX + gapX
      const cz = cell.homeZ + gapZ
      pts.push(cx - halfCell, 0.01, cz - halfCell, cx + halfCell, 0.01, cz - halfCell)
      pts.push(cx + halfCell, 0.01, cz - halfCell, cx + halfCell, 0.01, cz + halfCell)
      pts.push(cx + halfCell, 0.01, cz + halfCell, cx - halfCell, 0.01, cz + halfCell)
      pts.push(cx - halfCell, 0.01, cz + halfCell, cx - halfCell, 0.01, cz - halfCell)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: '#ff9933', transparent: true, opacity: 0.7,
  }))
}

// ── Sphere projection shader patch ───────────────────────────────────
// Keeps clip planes in cube space but curves vertices to a sphere.
// Height above the cube face is ADDITIVE — objects stick up from the curved surface.

interface SphereUniforms {
  uFaceNormal: { value: THREE.Vector3 }
  uBezier: { value: THREE.Vector4 }  // (cx1, cy1, cx2, cy2)
  uMaxHeight: { value: number }
}

function createSphereUniforms(): SphereUniforms {
  return {
    uFaceNormal: { value: new THREE.Vector3(0, 1, 0) },
    uBezier: { value: new THREE.Vector4(0.25, 0.1, 0.75, 0.9) },
    uMaxHeight: { value: 1.0 },
  }
}

function patchMaterialForSphere(material: THREE.Material, uniforms: SphereUniforms) {
  // Compose with any existing onBeforeCompile (e.g. the Fresnel fragment
  // patch applied in buildDiorama) so both patches coexist on the same
  // material — last-wins assignment would silently drop Fresnel control.
  // Idempotent: the bird flock shares one material across 30 meshes; without
  // this guard every re-patch stacks another uniform declaration producing
  // a duplicate-declaration GLSL compile error → invisible meshes.
  const ud = material.userData as { __spherePatched?: boolean }
  if (ud.__spherePatched) return
  ud.__spherePatched = true
  const prevOBC = material.onBeforeCompile
  const prevKey = material.customProgramCacheKey
  material.onBeforeCompile = (shader, renderer) => {
    prevOBC?.call(material, shader, renderer)
    shader.uniforms.uFaceNormal = uniforms.uFaceNormal

    // Declare uniforms at top level (outside main)
    shader.uniforms.uBezier = uniforms.uBezier
    shader.uniforms.uMaxHeight = uniforms.uMaxHeight

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      uniform vec3 uFaceNormal;
      uniform vec4 uBezier;    // (cx1, cy1, cx2, cy2)
      uniform float uMaxHeight;

      // Cubic bezier evaluation
      float cbez(float t, float p0, float p1, float p2, float p3) {
        float mt = 1.0 - t;
        return mt*mt*mt*p0 + 3.0*mt*mt*t*p1 + 3.0*mt*t*t*p2 + t*t*t*p3;
      }

      // Solve for t given x using Newton's method (P0.x=0, P3.x=1)
      float solveBezierT(float x, float x1, float x2) {
        float t = x;
        for (int i = 0; i < 8; i++) {
          float cx = cbez(t, 0.0, x1, x2, 1.0);
          float dx = cx - x;
          if (abs(dx) < 0.001) break;
          float dt = 3.0*(1.0-t)*(1.0-t)*x1
                   + 6.0*(1.0-t)*t*(x2-x1)
                   + 3.0*t*t*(1.0-x2);
          if (abs(dt) < 0.0001) break;
          t -= dx / dt;
          t = clamp(t, 0.0, 1.0);
        }
        return t;
      }

      // Evaluate the bezier height curve: input [0,1] → output [0,~1]
      float evalHeightCurve(float h) {
        float t = solveBezierT(clamp(h, 0.0, 1.0), uBezier.x, uBezier.z);
        return cbez(t, 0.0, uBezier.y, uBezier.w, 1.0);
      }`,
    )

    // Replace project_vertex with additive sphere projection
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      // For InstancedMesh, fold the per-instance matrix into object-space
      // position first — without this, every instance ends up at the first
      // instance's sphere-projected position (silent failure: grass blades
      // collapse onto one point, invisible). Three.js auto-declares
      // \`instanceMatrix\` when USE_INSTANCING is defined.
      #ifdef USE_INSTANCING
        vec4 _osPos = instanceMatrix * vec4(transformed, 1.0);
      #else
        vec4 _osPos = vec4(transformed, 1.0);
      #endif

      // Cube-space position for clipping (BEFORE sphere projection)
      #if NUM_CLIPPING_PLANES > 0
        vClipPosition = -(modelViewMatrix * _osPos).xyz;
      #endif

      // Sphere projection with bezier height curve
      vec4 worldPos = modelMatrix * _osPos;
      vec3 wp = worldPos.xyz;
      float faceDistance = dot(wp, uFaceNormal);
      float rawHeight = faceDistance - 1.0;

      // Apply bezier curve to normalized height
      float normalizedH = clamp(rawHeight / uMaxHeight, 0.0, 1.0);
      float curvedH = rawHeight <= 0.0 ? rawHeight : evalHeightCurve(normalizedH) * uMaxHeight;

      vec3 basePoint = wp - rawHeight * uFaceNormal;
      vec3 sphereBase = normalize(basePoint);
      vec3 spherePos = sphereBase * (1.0 + curvedH);

      // Correct normals for sphere curvature.
      // sphereNormal is WORLD-space (radial from origin). To land in view
      // space we apply mat3(viewMatrix), not normalMatrix — the latter
      // expects object-space input and would yield a garbage direction,
      // corrupting N·V and therefore Fresnel on ground geometry.
      #ifdef USE_NORMAL
        vec3 sphereNormal = normalize(sphereBase);
        // Ground-level geometry follows the sphere, tall objects keep their own normals.
        float normalBlend = clamp(1.0 - normalizedH * 2.0, 0.0, 1.0);
        vNormal = normalize(mix(vNormal, mat3(viewMatrix) * sphereNormal, normalBlend));
      #endif

      vec4 mvPosition = viewMatrix * vec4(spherePos, 1.0);
      gl_Position = projectionMatrix * mvPosition;

      #ifdef USE_FOG
        vFogDepth = -mvPosition.z;
      #endif
      `,
    )

    // Remove the default vClipPosition assignment since we handle it above
    shader.vertexShader = shader.vertexShader.replace(
      '#include <clipping_planes_vertex>',
      '// clipping handled in project_vertex override',
    )
  }

  material.customProgramCacheKey = () => (prevKey?.call(material) ?? '') + '|sphereProjectionAdditive'
  material.needsUpdate = true
}

function patchSceneForSphere(root: THREE.Object3D, uniforms: SphereUniforms) {
  root.traverse(child => {
    if (!(child as THREE.Mesh).isMesh) return
    const mesh = child as THREE.Mesh
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) patchMaterialForSphere(m, uniforms)
  })
}

// ── Component ────────────────────────────────────────────────────────

export interface BezierState {
  cx1: number; cy1: number; cx2: number; cy2: number
}

export function TileGrid({ mode = 'split', bezier }: {
  mode?: TileMode
  bezier?: BezierState
}) {
  const { gl, scene, camera } = useThree()
  const bz = bezier ?? { cx1: 0.25, cy1: 0.1, cx2: 0.75, cy2: 0.9 }
  const dioramaRef = useRef<DioramaScene | null>(null)
  const sphereVisRef = useRef<SphereVisibility | null>(null)
  const dioramaSceneRef = useRef<THREE.Scene | null>(null)
  const cellsRef = useRef<CellDef[]>([])
  const overlaySceneRef = useRef<THREE.Scene | null>(null)
  const rendersRef = useRef<CellRender[]>([])
  const sphereUniformsRef = useRef<SphereUniforms | null>(null)
  const animStartRef = useRef<{ id: number; start: number } | null>(null)
  const quadRef = useRef<THREE.Mesh | null>(null)
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null)
  const dirLightRef = useRef<THREE.DirectionalLight | null>(null)
  const terrainSceneRef = useRef<THREE.Scene | null>(null)
  const terrainMeshRef = useRef<THREE.Mesh | null>(null)
  const terrainAmbientRef = useRef<THREE.AmbientLight | null>(null)
  const terrainDirRef = useRef<THREE.DirectionalLight | null>(null)

  // Offscreen target for the 24-pass sphere output. Post-fx runs on a
  // fullscreen quad sampling this texture, so bloom/vignette can coexist
  // with the custom render loop.
  //
  // `depthBuffer: true` here makes drei's useFBO attach a DepthTexture
  // (see node_modules/@react-three/drei/core/Fbo.js:31). That depth
  // texture is what the composite quad below samples to repopulate the
  // main framebuffer's depth — without it, PostFx (DoF, N8AO, SSAO) sees
  // the cleared far-plane depth everywhere the planet renders and can't
  // build a correct per-pixel circle-of-confusion / AO.
  const sphereTarget = useFBO({ depthBuffer: true })

  // Publish sphereTarget.depthTexture so PostFx's DoF can sample planet
  // depth directly. The composite-quad gl_FragDepth write into EffectComposer's
  // RT depth doesn't reach DoF's CoC pass (symptom: "only bokeh works").
  // Sphere mode only; null otherwise so PostFx falls through to its default.
  useEffect(() => {
    hudUniforms.uSphereDepth.value = mode === 'sphere' ? sphereTarget.depthTexture : null
    return () => { hudUniforms.uSphereDepth.value = null }
  }, [mode, sphereTarget])

  const quadMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    // Write both color AND depth. The depth attachment of sphereTarget is
    // a DepthTexture (FloatType, window-space [0..1]) — sampling .r and
    // assigning to gl_FragDepth is a 1:1 pass-through, giving PostFx the
    // true per-pixel depth of the rendered planet surface.
    fragmentShader: `
      uniform sampler2D uMap;
      uniform sampler2D uDepth;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(uMap, vUv);
        gl_FragDepth = texture2D(uDepth, vUv).r;
      }
    `,
    uniforms: {
      uMap:   { value: sphereTarget.texture },
      uDepth: { value: sphereTarget.depthTexture },
    },
    depthTest: false,
    depthWrite: true,
  }), [sphereTarget])

  useEffect(() => {
    gl.localClippingEnabled = true

    // Check for a `?glb=<path>` (or `?glb=1` → /diorama.glb) URL query. When
    // present, we start with an empty root and async-swap in the loaded
    // scene as soon as it arrives — keeps the useEffect synchronous, avoids
    // paying the ~500 ms imperative build cost just to throw it away, and
    // falls back to imperative if the fetch/parse fails.
    const glbParam = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('glb')
      : null
    const glbPath = glbParam === '1' ? '/diorama.glb' : glbParam

    // In sphere mode, terrain is rendered as a single global SphereGeometry
    // mesh (see globalTerrainScene below) — the flat "terrain" plane stays
    // in the diorama root but is hidden to avoid double-drawing. We can't
    // simply omit it: buildGrass (PV11) traverses the root looking for a
    // mesh whose name starts with "ground"/"terrain" to sample spawn XZ
    // bounds from. Without that plane present, imperative sphere mode
    // fails the lookup and grass silently skips. Keep the plane in the
    // root with visible=false — three.js skips render for invisible
    // meshes, traverse still visits them.
    let diorama: DioramaScene = glbPath
      ? { root: new THREE.Group(), update: () => {} }
      : buildDiorama({ includeTerrain: true })
    if (!glbPath) hideFlatTerrainInSphereMode(diorama.root, mode)
    dioramaRef.current = diorama
    if (!glbPath) registerDioramaAudioAnchors(diorama.root)

    // Disable frustum culling — the sphere projection shader moves vertices
    // to positions that differ from the bounding sphere Three.js computes
    // from cube-space geometry. Without this, objects near the screen edge
    // get incorrectly culled.
    diorama.root.traverse(child => { child.frustumCulled = false })

    const dScene = new THREE.Scene()
    dScene.add(diorama.root)
    // In sphere mode the diorama is lit by the HDRI environment only — we
    // mirror scene.environment onto dScene each frame below. For preview
    // modes (split/cube) we still want some direct light because those
    // render via the same dScene but the main R3F scene has no Environment
    // mounted. Use a soft ambient + a fill directional as a fallback; when
    // dScene.environment is set (sphere mode), these are effectively dwarfed.
    const ambient = new THREE.AmbientLight(0xffffff, 0.35)
    dScene.add(ambient)
    ambientLightRef.current = ambient
    const dir = new THREE.DirectionalLight(0xffffff, 0.7)
    dir.position.set(3, 4, 2)
    dScene.add(dir)
    dirLightRef.current = dir
    dioramaSceneRef.current = dScene

    // Sphere mode only: build a separate scene holding the global sphere
    // terrain. Rendered once per frame (no clip planes), giving a single
    // continuous green base across all cube faces. Per-tile object passes
    // render on top with their own clip planes.
    //
    // When `?glb=…` is active, the loaded glb carries its own ground/terrain
    // mesh (the meadow's authoritative emission surface), so rendering the
    // global sphere terrain would double-draw the same visual layer. Skip
    // building it for glb mode — the glb's cube-net terrain projects onto
    // the sphere via the same pipeline as every other prop.
    if (mode === 'sphere' && !glbPath) {
      // Source PBR scalars from the (hidden) cube-net terrain mesh so any
      // material edits authored upstream — imperative `mat()` in
      // buildTerrain or a Blender-edited terrain on the glb path — drive
      // the visible sphere-terrain's reflectivity / colour. Without this
      // the sphere-terrain stays at hard-coded `roughness:0.95
      // metalness:0` regardless of what the author painted (P23 trap:
      // the consumer queried wasn't tracking the same mesh the author
      // edited).
      let terrainSrcMat: THREE.Material | null = null
      diorama.root.traverse(o => {
        if (terrainSrcMat) return
        const m = o as THREE.Mesh
        if (m.isMesh && m.name === 'terrain') {
          const mat = m.material
          terrainSrcMat = Array.isArray(mat) ? mat[0] : mat
        }
      })
      const terrainMesh = buildSphereTerrain(terrainSrcMat)
      terrainMesh.frustumCulled = false
      const terrainScene = new THREE.Scene()
      terrainScene.add(terrainMesh)
      // Mirror dScene's lighting fallback so the terrain matches per-tile
      // materials when physical lights are on. Same intensities — the
      // ambient/dir refs already control intensity per frame.
      const tAmbient = new THREE.AmbientLight(0xffffff, 0.35)
      terrainScene.add(tAmbient)
      const tDir = new THREE.DirectionalLight(0xffffff, 0.7)
      tDir.position.set(3, 4, 2)
      terrainScene.add(tDir)
      terrainSceneRef.current = terrainScene
      terrainMeshRef.current = terrainMesh
      terrainAmbientRef.current = tAmbient
      terrainDirRef.current = tDir
    }

    const cells = buildCellDefs()
    cellsRef.current = cells

    // Pre-compute per-cell transforms + clip planes. Sphere mode uses NO
    // gap — any positive gap manifests as sky-coloured strips at the cube
    // edges (each within-face clip plane of size halfCell = (CELL-gap)/2
    // stops short of the face border by gap/2; the old global sphere-
    // terrain used to fill that, but in glb mode we skip it so the strips
    // read as seams). cube/split previews keep their gaps — there they're
    // an intentional visual separator between cells.
    const gap = mode === 'split' ? SPLIT_GAP : mode === 'cube' ? CUBE_GAP : 0
    rendersRef.current = cells.map(c => {
      // Sphere uses CUBE clip planes (flat, no artifacts) — shader does the curving
      if (mode === 'sphere' || mode === 'cube') return cubeCellRender(c, gap)
      return flatCellRender(c, gap)
    })

    // In sphere mode, patch all diorama materials with sphere projection shader
    if (mode === 'sphere') {
      const su = createSphereUniforms()
      sphereUniformsRef.current = su
      patchSceneForSphere(diorama.root, su)
      // Build per-tile visibility map after patching. Uses each mesh's
      // current AABB in cube-net coords to decide which of the 24 home
      // tiles' 1×1 patches it overlaps. Animated subtrees + InstancedMesh
      // (grass) bypass tile gating via the alwaysVisible set.
      sphereVisRef.current = buildSphereVisibility(diorama.root, diorama.animations ?? [])
    }

    // Overlay lines (only for dev modes, not sphere/planet)
    if (mode !== 'sphere') {
      const oScene = new THREE.Scene()
      oScene.add(buildOverlayLines(cells, mode))
      overlaySceneRef.current = oScene
    }

    // Set matrixAutoUpdate false so we can set matrix directly
    diorama.root.matrixAutoUpdate = false

    // Async swap-in for URL-requested glb. Keeps the mount synchronous —
    // if the load fails, fall back to imperative; if it succeeds, detach
    // the stub root and attach the loaded scene (reapplying the sphere
    // projection patch on the new materials). All cleanup goes through
    // dioramaRef.current so whatever root is live gets disposed on unmount.
    let swapCancelled = false
    const swapInScene = (url: string, fallbackMode: 'imperative' | 'none' = 'imperative') => {
      return loadGlbDiorama(url).then(loaded => {
        if (swapCancelled) return
        const next = loaded ?? (
          fallbackMode === 'imperative'
            ? (() => {
                const d = buildDiorama({ includeTerrain: true })
                hideFlatTerrainInSphereMode(d.root, mode)
                return d
              })()
            : null
        )
        if (!next) return  // keep current scene on failed reload
        const prev = dioramaRef.current
        if (prev) {
          // Audio cleanup BEFORE GPU dispose — bus's unregisterLoop reads
          // the loop's anchor (now in the prev tree) to stop the node, so
          // run while the tree is still intact.
          prev.dispose?.()
          dScene.remove(prev.root)
          prev.root.traverse(c => {
            const m = c as THREE.Mesh
            if (!m.isMesh) return
            m.geometry?.dispose()
            const mat = m.material
            if (Array.isArray(mat)) mat.forEach(x => x.dispose())
            else mat?.dispose()
          })
        }
        next.root.traverse(c => { c.frustumCulled = false })
        next.root.matrixAutoUpdate = false
        dScene.add(next.root)
        if (mode === 'sphere' && sphereUniformsRef.current) {
          patchSceneForSphere(next.root, sphereUniformsRef.current)
          // Recompute per-tile visibility for the new tree — old map's
          // mesh refs are stale (point at the disposed prev.root).
          sphereVisRef.current = buildSphereVisibility(next.root, next.animations ?? [])
        }
        diorama = next
        dioramaRef.current = next
        registerDioramaAudioAnchors(next.root)
        // Re-apply the Leva panel's current values to the fresh meadow so
        // density / flower split / colours / wind survive the hot reload.
        // buildGrass defaults mesh.count to 50% otherwise, which would read
        // as "all my settings got reset."
        grassRefs.reapplyControls?.()
      })
    }

    if (glbPath) {
      void swapInScene(glbPath)
      // Stash cancellation on the ref so the outer cleanup can flip it.
      ;(dioramaRef as unknown as { _cancelSwap?: () => void })._cancelSwap = () => {
        swapCancelled = true
      }

      // HMR hot-reload: Vite plugin fires `diorama:changed` when
      // public/diorama.glb is rewritten (by the Blender addon's Live Mode).
      // We refetch with a cache-bust query, swap scene in place — no page
      // reload, so Leva knobs + camera angle + tutorial state all survive.
      // `fallbackMode='none'` → if the new file is briefly invalid (mid-
      // write race), keep the previous scene instead of dropping back to
      // imperative.
      if (import.meta.hot) {
        const onDioramaChanged = ({ ts }: { ts: number }) => {
          void swapInScene(`${glbPath}?t=${ts}`, 'none')
        }
        import.meta.hot.on('diorama:changed', onDioramaChanged)
        // Cleanup wired into the effect teardown below via the hmr off hook.
        ;(dioramaRef as unknown as { _offHmr?: () => void })._offHmr = () => {
          import.meta.hot?.off('diorama:changed', onDioramaChanged)
        }
      }
    }

    // Publish a top-down cube-net snapshot callback for GrassPanel's "save"
    // button. Builds a THROWAWAY unpatched diorama so the shot is the flat
    // cube-net layout regardless of the mode currently on screen (sphere-mode
    // renders would show the spherified projection — not useful as a mask
    // reference). Renders offscreen, readPixels, encodes PNG, disposes.
    grassRefs.captureTopView = async () => {
      const throwaway = buildDiorama({ includeTerrain: true })
      const scene = new THREE.Scene()
      scene.background = new THREE.Color('#1a2028')
      scene.add(throwaway.root)
      // No environment map on the throwaway scene, so PBR materials appear
      // black without direct light. Crank ambient + directional to produce a
      // legible top-down reference shot.
      scene.add(new THREE.AmbientLight(0xffffff, 3.0))
      const dir = new THREE.DirectionalLight(0xffffff, 2.0)
      dir.position.set(0, 10, 0.5)
      scene.add(dir)
      const fill = new THREE.HemisphereLight(0xbcd4ff, 0x5b4a33, 1.2)
      scene.add(fill)

      const W = 1200, H = 900  // 4:3 matches 8×6 net aspect
      const cam = new THREE.OrthographicCamera(-HALF_W - 0.2, HALF_W + 0.2, HALF_H + 0.2, -HALF_H - 0.2, 0.1, 100)
      cam.position.set(0, 20, 0)
      cam.lookAt(0, 0, 0)

      const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType })
      const prevTarget = gl.getRenderTarget()
      const prevClip = gl.clippingPlanes
      gl.clippingPlanes = []
      gl.setRenderTarget(rt)
      gl.clear(true, true, true)
      gl.render(scene, cam)
      const pixels = new Uint8Array(W * H * 4)
      gl.readRenderTargetPixels(rt, 0, 0, W, H, pixels)
      gl.setRenderTarget(prevTarget)
      gl.clippingPlanes = prevClip
      rt.dispose()

      // Dispose the throwaway diorama (all meshes + materials).
      throwaway.root.traverse(c => {
        const m = c as THREE.Mesh
        if (!m.isMesh) return
        m.geometry?.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach(x => x.dispose())
        else mat?.dispose()
      })

      // WebGL framebuffers are bottom-up; flip rows into a 2D canvas.
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      const img = ctx.createImageData(W, H)
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4
        img.data.set(pixels.subarray(src, src + W * 4), y * W * 4)
      }
      ctx.putImageData(img, 0, 0)
      return new Promise<Blob | null>(res => canvas.toBlob(b => res(b), 'image/png'))
    }

    // Export a clean flat cube-net .glb that Blender can open. Builds a
    // throwaway imperative diorama with skipMeadow=true so the ~231K grass
    // instance matrices don't balloon the file (meadow is procedural — it
    // rebuilds from code on load). Includes the flat terrain plane so
    // Blender shows the cross cube-net as a visible ground, and identity
    // transforms throughout so the exported scene opens centred at origin.
    grassRefs.saveDiorama = async () => {
      const throwaway = buildDiorama({ includeTerrain: true, skipMeadow: true })
      throwaway.root.updateMatrixWorld(true)

      // Auto-generate AABB colliders for every named prop in the
      // throwaway. Each top-level child of the diorama root represents
      // one prop group (hut, windmill, trees, fence, ...). We skip
      // ground/terrain/flowers/road/stonepath because walking ON those is
      // intentional. Each collider is a unit cube parented to the root,
      // tagged with `userData.rubics_role = 'collider'` — GLTFExporter
      // serialises userData as glTF `extras`, which the import side
      // (loadGlbDiorama traversal + Blender's Import operator) reads to
      // sort into rubics_collider. Idempotent on re-bake — throwaway is
      // brand new each call.
      const SKIP_PREFIXES = ['ground', 'terrain', 'flower', 'road', 'stonepath', 'path', '_col_']
      const colliderGroup = new THREE.Group()
      colliderGroup.name = 'rubics_collider'
      const _box = new THREE.Box3()
      for (const child of throwaway.root.children) {
        const name = (child.name || '').toLowerCase()
        if (!name) continue
        if (SKIP_PREFIXES.some(p => name.startsWith(p))) continue
        _box.makeEmpty().setFromObject(child)
        if (_box.isEmpty() || !isFinite(_box.min.x)) continue
        const sx = Math.max(0.02, _box.max.x - _box.min.x)
        const sy = Math.max(0.02, _box.max.y - _box.min.y)
        const sz = Math.max(0.02, _box.max.z - _box.min.z)
        const cx = (_box.min.x + _box.max.x) * 0.5
        const cy = (_box.min.y + _box.max.y) * 0.5
        const cz = (_box.min.z + _box.max.z) * 0.5
        const geom = new THREE.BoxGeometry(1, 1, 1)
        // Use a basic material — the box renders only inside Blender as a
        // wireframe authoring primitive on this side. Doesn't matter
        // visually; we tag it as collider so import sorts + hides it.
        const mat = new THREE.MeshBasicMaterial({ visible: false })
        const cube = new THREE.Mesh(geom, mat)
        cube.name = `_col_${child.name}`
        cube.position.set(cx, cy, cz)
        cube.scale.set(sx, sy, sz)
        cube.userData = { rubics_role: 'collider' }
        colliderGroup.add(cube)
      }
      throwaway.root.add(colliderGroup)

      // Bake procedural animations into keyframe clips. The imperative
      // diorama drives motion via `update(t)` callbacks (windmill spin,
      // car path, smoke wisps, birds, etc.) — GLTFExporter can't capture
      // those. We sample each tracked node's position/quaternion/scale at
      // 30 Hz over a 4-second loop, build per-channel KeyframeTracks,
      // bundle into one AnimationClip. Loop-friendly content (windmill,
      // birds) lines up at clip end; non-looping content (smoke wisps)
      // approximates well enough for a 4s capture.
      const FPS = 30
      const DURATION = 4.0
      const SAMPLES = Math.round(FPS * DURATION) + 1
      // Collect candidate animated nodes — every child of root that's
      // NOT the new collider group, NOT terrain/ground (static), NOT
      // already in colliderGroup. Includes nested rotors / sub-meshes
      // because windmill blades are sub-children of the windmill group.
      const animTargets: { node: THREE.Object3D; path: string }[] = []
      throwaway.root.traverse(node => {
        if (node === throwaway.root) return
        if (node === colliderGroup) return
        if (node.parent === colliderGroup) return
        const lname = (node.name || '').toLowerCase()
        if (!lname) return
        if (lname.startsWith('ground') || lname.startsWith('terrain')) return
        if (lname.startsWith('_col_')) return
        animTargets.push({ node, path: node.name })
      })
      // Time array, shared across tracks.
      const times = new Float32Array(SAMPLES)
      for (let i = 0; i < SAMPLES; i++) times[i] = i / FPS
      // Per-target sample buffers.
      type Buf = { pos: Float32Array; rot: Float32Array; scl: Float32Array }
      const buffers = new Map<THREE.Object3D, Buf>()
      for (const { node } of animTargets) {
        buffers.set(node, {
          pos: new Float32Array(SAMPLES * 3),
          rot: new Float32Array(SAMPLES * 4),
          scl: new Float32Array(SAMPLES * 3),
        })
      }
      // Drive `update(t)` and snapshot each frame.
      for (let s = 0; s < SAMPLES; s++) {
        throwaway.update(s / FPS)
        throwaway.root.updateMatrixWorld(true)
        for (const { node } of animTargets) {
          const b = buffers.get(node)!
          b.pos[s * 3 + 0] = node.position.x
          b.pos[s * 3 + 1] = node.position.y
          b.pos[s * 3 + 2] = node.position.z
          b.rot[s * 4 + 0] = node.quaternion.x
          b.rot[s * 4 + 1] = node.quaternion.y
          b.rot[s * 4 + 2] = node.quaternion.z
          b.rot[s * 4 + 3] = node.quaternion.w
          b.scl[s * 3 + 0] = node.scale.x
          b.scl[s * 3 + 1] = node.scale.y
          b.scl[s * 3 + 2] = node.scale.z
        }
      }
      // Build tracks. Skip tracks whose values never change (static
      // props produce noise-free flat arrays — emitting them just bloats
      // the glb). Tolerance ~1e-5 catches floating-point drift while
      // letting genuinely-animated tracks through.
      const tracks: THREE.KeyframeTrack[] = []
      const FLAT_EPS = 1e-5
      const isFlat = (arr: Float32Array, stride: number): boolean => {
        for (let k = 0; k < stride; k++) {
          const ref = arr[k]
          for (let s = 1; s < SAMPLES; s++) {
            if (Math.abs(arr[s * stride + k] - ref) > FLAT_EPS) return false
          }
        }
        return true
      }
      for (const { node, path } of animTargets) {
        const b = buffers.get(node)!
        if (!isFlat(b.pos, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${path}.position`, Array.from(times), Array.from(b.pos)))
        if (!isFlat(b.rot, 4)) tracks.push(new THREE.QuaternionKeyframeTrack(`${path}.quaternion`, Array.from(times), Array.from(b.rot)))
        if (!isFlat(b.scl, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${path}.scale`, Array.from(times), Array.from(b.scl)))
      }
      const clips: THREE.AnimationClip[] = []
      if (tracks.length > 0) {
        clips.push(new THREE.AnimationClip('rubics_loop', DURATION, tracks))
      }

      // Restore matrices to t=0 so the static export pose is sensible
      // (otherwise the glb's "rest" pose is whatever t=4s left behind).
      throwaway.update(0)
      throwaway.root.updateMatrixWorld(true)

      const exporter = new GLTFExporter()
      const arrayBuffer = await new Promise<ArrayBuffer | null>(resolve => {
        exporter.parse(
          throwaway.root,
          result => {
            if (result instanceof ArrayBuffer) resolve(result)
            else resolve(null)
          },
          err => { console.error('[diorama] GLTFExporter failed:', err); resolve(null) },
          { binary: true, animations: clips, includeCustomExtensions: true },
        )
      })
      // Dispose throwaway (props + colliders) before returning.
      throwaway.root.traverse(c => {
        const m = c as THREE.Mesh
        if (!m.isMesh) return
        m.geometry?.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach(x => x.dispose())
        else mat?.dispose()
      })
      if (!arrayBuffer) return null
      // eslint-disable-next-line no-console
      console.log(`[diorama] baked: ${colliderGroup.children.length} colliders, ${tracks.length} animation tracks, ${arrayBuffer.byteLength} bytes`)
      return new Blob([arrayBuffer], { type: 'model/gltf-binary' })
    }

    // Swap-rebuild grass using a user-painted mask (or clear back to AABB
    // exclusion). Disposes the previous grass InstancedMesh, asks buildGrass
    // for a new one driven by pixel sampling, then re-applies the sphere
    // projection patch (idempotent guard skips already-patched props and only
    // touches the new grass material).
    // Shared rebuilder — disposes existing meadow meshes, re-runs buildGrass
    // with BOTH current masks, re-applies sphere patch + Leva state. Called by
    // rebuildWithMask AND rebuildWithFlowerMask; each writes to its own
    // ref slot first so the fresh build picks them up.
    const rebuildMeadow = () => {
      const diorama = dioramaRef.current
      if (!diorama) return
      for (const old of grassRefs.meadowMeshes) {
        old.parent?.remove(old)
        old.geometry.dispose()
        const m = old.material
        if (Array.isArray(m)) m.forEach(x => x.dispose())
        else m.dispose()
      }
      const grass = buildGrass(diorama.root, {
        maskImage:       grassRefs.activeMask ?? undefined,
        flowerMaskImage: grassRefs.activeFlowerMask ?? undefined,
      })
      for (const mesh of grass.meshes) diorama.root.add(mesh)
      if (mode === 'sphere' && sphereUniformsRef.current) {
        patchSceneForSphere(diorama.root, sphereUniformsRef.current)
      }
      diorama.root.updateMatrixWorld(true)
      grassRefs.reapplyControls?.()
    }
    grassRefs.rebuildWithMask = (mask) => {
      // Persist across hot-reload swaps: loadGlbDiorama reads activeMask
      // and forwards it to buildGrass. null here = clear (drop back to
      // AABB exclusion). Store BEFORE the rebuild so the new grass uses it.
      grassRefs.activeMask = mask
      rebuildMeadow()
    }
    grassRefs.rebuildWithFlowerMask = (mask) => {
      grassRefs.activeFlowerMask = mask
      rebuildMeadow()
    }

    return () => {
      gl.localClippingEnabled = false
      gl.clippingPlanes = []
      grassRefs.captureTopView = null
      grassRefs.rebuildWithMask = null
      grassRefs.rebuildWithFlowerMask = null
      grassRefs.saveDiorama = null
      unregisterDioramaAudioAnchors()
      ;(dioramaRef as unknown as { _cancelSwap?: () => void })._cancelSwap?.()
      ;(dioramaRef as unknown as { _offHmr?: () => void })._offHmr?.()
      // Dispose whatever root is LIVE in the ref (may be the stub, the
      // imperative fallback, or the loaded glb — all same disposal shape).
      const live = dioramaRef.current ?? diorama
      // Run the live diorama's own dispose hook (KHR_audio_emitter loop
      // unregistration etc.) BEFORE we tear the GPU resources down.
      live.dispose?.()
      live.root.traverse(child => {
        if ((child as THREE.Mesh).isMesh) {
          ;(child as THREE.Mesh).geometry?.dispose()
          const m = (child as THREE.Mesh).material
          if (Array.isArray(m)) m.forEach(mt => mt.dispose())
          else m?.dispose()
        }
      })
    }
  }, [gl, mode])

  useFrame(({ clock }) => {
    const diorama = dioramaRef.current
    const dScene = dioramaSceneRef.current
    const renders = rendersRef.current
    const oScene = overlaySceneRef.current
    if (!diorama || !dScene || renders.length === 0) return

    // Mirror the main scene's environment (set by HDRIEnvironment) onto the
    // offscreen dScene so MeshStandardMaterial inside the diorama samples
    // the same IBL as the outer world — avoids a dark, flatly-lit sphere.
    if (dScene.environment !== scene.environment) {
      dScene.environment = scene.environment
      dScene.environmentIntensity = scene.environmentIntensity
    }
    // Keep live HDRI parameters in sync
    dScene.environmentIntensity = scene.environmentIntensity
    if (scene.environmentRotation && dScene.environmentRotation) {
      dScene.environmentRotation.copy(scene.environmentRotation)
    }
    // Same env mirroring for the global terrain scene (sphere mode only).
    const terrainScene = terrainSceneRef.current
    if (terrainScene) {
      terrainScene.environment = scene.environment
      terrainScene.environmentIntensity = scene.environmentIntensity
      if (scene.environmentRotation && terrainScene.environmentRotation) {
        terrainScene.environmentRotation.copy(scene.environmentRotation)
      }
    }

    // Toggle the fallback direct lights driven by the store flag.
    const hs = useHdri.getState()
    const physicalLights = hs.physicalLights
    if (ambientLightRef.current) {
      ambientLightRef.current.intensity = physicalLights ? 0.35 : 0
    }
    if (dirLightRef.current) {
      dirLightRef.current.intensity = physicalLights ? 0.7 : 0
    }
    if (terrainAmbientRef.current) {
      terrainAmbientRef.current.intensity = physicalLights ? 0.35 : 0
    }
    if (terrainDirRef.current) {
      terrainDirRef.current.intensity = physicalLights ? 0.7 : 0
    }

    // Apply live Fresnel/IBL knobs to every MeshStandardMaterial in the
    // diorama. envMapIntensity dampens IBL globally (incl. the specular
    // Fresnel rim at grazing angles). Roughness boost softens the rim by
    // blurring the specular IBL sample — original roughness is cached the
    // first time we touch the material (userData.__baseRoughness) so the
    // slider is additive rather than destructive.
    const envI = hs.envMapIntensity
    const roughBoost = hs.roughnessBoost
    fresnelUniform.value = hs.fresnelEnabled ? 1 : 0
    const applyIblKnobs = (mat: THREE.Material | THREE.Material[]) => {
      const mats = Array.isArray(mat) ? mat : [mat]
      for (const mm of mats) {
        const std = mm as THREE.MeshStandardMaterial
        if (typeof std.envMapIntensity !== 'number') continue
        std.envMapIntensity = envI
        const ud = std.userData as { __baseRoughness?: number }
        if (ud.__baseRoughness === undefined) ud.__baseRoughness = std.roughness
        std.roughness = Math.min(1, ud.__baseRoughness + roughBoost)
      }
    }
    diorama.root.traverse(child => {
      const m = (child as THREE.Mesh).material
      if (m) applyIblKnobs(m)
    })
    if (terrainMeshRef.current) applyIblKnobs(terrainMeshRef.current.material)

    // Ease HUD attract opacity toward its target. 1.0 while in attract mode
    // (fresh session, no moves yet); 0.0 once the player commits their first
    // rotation. ~1 s ease over the transition feels "aha, they got it."
    const pState = usePlanet.getState()
    const hudTarget = pState.hudAttractMode ? 1 : 0
    const HUD_EASE = 0.04  // per-frame lerp factor ≈ 1s at 60fps
    hudUniforms.uHudOpacity.value += (hudTarget - hudUniforms.uHudOpacity.value) * HUD_EASE
    // Ease easy-mode colour weight toward current store value. Same ease so
    // toggling feels smooth rather than snappy.
    const easyTarget = pState.easyMode ? 1 : 0
    hudUniforms.uHudEasyMode.value += (easyTarget - hudUniforms.uHudEasyMode.value) * HUD_EASE

    // Per-edge correctness mask for the HUD's easy-mode coloring. 0 = both
    // self and neighbor are at their home positions (green); 1 = either is
    // misplaced (red). Computed every frame — 24 tiles × 4 edges = 96 cheap
    // comparisons, no allocation.
    {
      const tiles = pState.tiles
      const mask = hudUniforms.uHudTileEdgeMask.value as Float32Array
      const atHome = _atHomeScratch
      for (let i = 0; i < 24; i++) atHome[i] = 0
      for (const t of tiles) {
        const idx = t.face * 4 + t.v * 2 + t.u
        const home = t.homeFace === t.face && t.homeU === t.u && t.homeV === t.v
        atHome[idx] = home ? 1 : 0
      }
      for (let idx = 0; idx < 24; idx++) {
        const selfHome = atHome[idx]
        const base = idx * 4
        for (let e = 0; e < 4; e++) {
          const neighIdx = NEIGHBOR_IDX[base + e]
          mask[base + e] = selfHome && atHome[neighIdx] ? 0 : 1
        }
      }
    }

    // ---- Grass cursor-trail stamping ----
    // Ring buffer of recent cursor positions feeds grassUniforms.uTrailPos
    // (flat Float32Array, xyz×GRASS_TRAIL_N). Each stamp carries a timestamp
    // in uTrailTime so the shader can fade pushes by (1 - age/decay)². We
    // stamp on cursor move (either 20 ms since last stamp OR 8 mm cursor
    // motion). uHudCursorActive is the canonical gate — already 0 when the
    // ray misses the planet AND force-suppressed during off-planet orbit
    // drags (Interaction.tsx: offPlanetDragRef), so the trail doesn't
    // extend during camera orbits.
    const now = clock.elapsedTime
    grassUniforms.uNow.value = now
    // Source the trail "brush" from EITHER the cursor raycast (orbit mode)
    // OR the player camera position (walk mode). Same shader path consumes
    // either — uTrailPos entries are normalised on the unit sphere inside
    // `<begin_vertex>`, so we can pass any world-space point that's near
    // the planet surface and the comparison stays correct.
    const isWalking = pState.cameraMode === 'walk'
    let stampX = 0, stampY = 0, stampZ = 0
    let stampActive = 0
    if (isWalking) {
      // Player feet: camera position projected from head height back down to
      // the surface. Camera sits at (groundR + PLAYER_H) along the up axis;
      // we want the brush to land at the actual standing point so blades
      // bend AROUND the player, not above their head.
      const camPos = camera.position
      const len = Math.sqrt(camPos.x * camPos.x + camPos.y * camPos.y + camPos.z * camPos.z)
      if (len > 1e-6) {
        const k = 1 / len  // unit direction; the shader normalises again
        stampX = camPos.x * k
        stampY = camPos.y * k
        stampZ = camPos.z * k
        stampActive = 1
      }
    } else if (hudUniforms.uHudCursorActive.value > 0.5) {
      const hit = hudUniforms.uHudCursor.value
      stampX = hit.x; stampY = hit.y; stampZ = hit.z
      stampActive = 1
    }
    grassUniforms.uHoverActive.value = stampActive
    let grassSwipeTarget = 0
    if (stampActive > 0.5) {
      const dt = now - grassTrailLastT
      const dx = stampX - grassTrailLastX
      const dy = stampY - grassTrailLastY
      const dz = stampZ - grassTrailLastZ
      const dd = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dt >= GRASS_STAMP_MIN_INTERVAL || dd >= GRASS_STAMP_MIN_DIST) {
        const i = grassTrailIdx
        const flat = grassUniforms.uTrailPos.value
        flat[i * 3 + 0] = stampX
        flat[i * 3 + 1] = stampY
        flat[i * 3 + 2] = stampZ
        grassUniforms.uTrailTime.value[i] = now
        grassTrailIdx = (i + 1) % GRASS_TRAIL_N
        grassTrailLastT = now
        grassTrailLastX = stampX
        grassTrailLastY = stampY
        grassTrailLastZ = stampZ
      }
      // Grass-swipe intensity for the audio loop: cursor speed (m/s) on
      // the planet, normalised so a leisurely sweep (~1.5 m/s) maxes out.
      // dt is wall-clock seconds since the last STAMP, not last frame —
      // it goes large during pauses, which we want (intensity drops).
      const speed = dt > 1e-3 ? dd / dt : 0
      grassSwipeTarget = Math.max(0, Math.min(1, speed / 1.5))
    }
    // Smooth toward target: 100ms attack, 250ms release. Frame dt is
    // approximated at 60Hz here — the smoothing tau dominates and audio
    // gain doesn't need sub-frame precision.
    {
      const tau = grassSwipeTarget > grassSwipeSmooth ? 0.10 : 0.25
      const k = Math.min(1, (1 / 60) / tau)
      grassSwipeSmooth += (grassSwipeTarget - grassSwipeSmooth) * k
      if (!Number.isFinite(grassSwipeSmooth)) grassSwipeSmooth = 0
    }
    audioBus.setGrassSwipeIntensity(grassSwipeSmooth)

    diorama.update(clock.elapsedTime)

    const prevAutoClear = gl.autoClear
    gl.autoClear = false

    // In sphere mode, render everything to an offscreen target so PostFx
    // can post-process the composited result via a fullscreen quad.
    // The quad lives in the same R3F scene — hide it for this pass to
    // avoid sampling itself.
    const renderingToTarget = mode === 'sphere'
    if (renderingToTarget) {
      if (quadRef.current) quadRef.current.visible = false
      gl.setRenderTarget(sphereTarget)
    }

    gl.clear(true, true, true)

    // R3F scene (background, helpers)
    gl.clippingPlanes = []
    gl.render(scene, camera)

    // Overlay
    if (oScene) {
      gl.clippingPlanes = []
      gl.render(oScene, camera)
    }

    // Per-tile: set transform + clip planes, render diorama
    const su = sphereUniformsRef.current
    if (su) {
      su.uBezier.value.set(bz.cx1, bz.cy1, bz.cx2, bz.cy2)
    }

    if (mode === 'sphere') {
      // Read tile state plus any in-flight drag/anim from the store.
      const state = usePlanet.getState()
      const { tiles, drag, anim } = state

      // Resolve the active rotation (drag wins over anim). Angle is applied
      // as an extra rotation around the origin to every tile in the slice.
      let activeAxis: Axis | null = null
      let activeSlice = 0
      let activeAngle = 0

      if (drag) {
        activeAxis = drag.axis
        activeSlice = drag.slice
        activeAngle = drag.angle
        animStartRef.current = null
      } else if (anim) {
        if (animStartRef.current?.id !== anim.id) {
          animStartRef.current = { id: anim.id, start: clock.elapsedTime }
        }
        const elapsed = clock.elapsedTime - animStartRef.current.start
        const t = Math.min(1, elapsed / (SLICE_ROT_MS / 1000))
        const eased = easeInOutCubic(t)
        activeAxis = anim.axis
        activeSlice = anim.slice
        activeAngle = anim.from + (anim.to - anim.from) * eased
        if (t >= 1) {
          animStartRef.current = null
          // Commit the rotation to tiles; takes effect next frame.
          state._finishAnim()
        }
      } else {
        animStartRef.current = null
      }

      const sliceQuat = activeAxis && activeAngle !== 0
        ? new THREE.Quaternion().setFromAxisAngle(AXIS_VEC[activeAxis], activeAngle)
        : null

      // CRITICAL ORDERING: write the slice + per-tile-orientation uniforms
      // BEFORE rendering the global terrain. The terrain's triplanar shader
      // reads these uniforms during its render; writing them after would
      // leave the terrain one frame stale, producing a visible "snap back"
      // on the commit frame where the tiles' face/u/v just updated but the
      // terrain hasn't caught up yet.
      if (activeAxis && activeAngle !== 0) {
        sliceRotUniforms.uSliceAxis.value.copy(AXIS_VEC[activeAxis])
        sliceRotUniforms.uSliceAngle.value = activeAngle
        sliceRotUniforms.uSliceSign.value = activeSlice === 1 ? 1 : -1
        sliceRotUniforms.uSliceActive.value = 1
      } else {
        sliceRotUniforms.uSliceActive.value = 0
      }

      // Per-tile orientation array: indexed by CURRENT cube position
      // (face*4 + v*2 + u). Used by the global terrain shader to sample the
      // texture from each tile's solved-state position — texture stays
      // painted on the tile across rotation commits.
      //
      // Flat Float32Array layout (4 floats per tile: x, y, z, w) so three.js
      // uploads reliably as a vec4[24] uniform.
      const oriArr = sliceRotUniforms.uTileOriInv.value as unknown as Float32Array
      for (const tile of tiles) {
        const idx = tile.face * 4 + tile.v * 2 + tile.u
        const q = tile.orientation
        const off = idx * 4
        // Quaternion conjugate = inverse for unit quats.
        oriArr[off]     = -q.x
        oriArr[off + 1] = -q.y
        oriArr[off + 2] = -q.z
        oriArr[off + 3] =  q.w
      }

      // Render the global continuous-sphere terrain ONCE, no clipping.
      // With the slice uniforms now up-to-date, the terrain's shader sees
      // the current frame's rotation state and tile orientations.
      if (terrainScene) {
        gl.clippingPlanes = []
        gl.render(terrainScene, camera)
      }

      // /optimize/ route: skip per-tile renders that can't contribute to
      // the framebuffer — back-face (planet's far hemisphere) and
      // out-of-frustum tiles. Terrain already covers the whole sphere
      // with depth + color, so culling the diorama overlay leaves no
      // hole. Animation tick + audio anchor traversal already ran above
      // (P23 — keep mesh tree intact, only skip the gl.render call).
      const optimize = (typeof window !== 'undefined') &&
        Boolean((window as unknown as { __rwOptimize?: boolean }).__rwOptimize)
      let optFrustum: THREE.Frustum | null = null
      const optCamDir = optVec3a
      let optTilesRendered = 0
      let optTilesCulled = 0
      if (optimize) {
        // View direction = camera position normalized (planet at origin).
        // Cull ONLY the strictly-opposite face. On a sphere the four
        // "side" faces remain quite visible from any viewing angle —
        // their content bulges past the limb. So we want a threshold
        // that only fires for tiles whose face normal points roughly
        // antipodal to the camera. -0.6 is the "back hemisphere" slice
        // (≥126° from view dir): for axis-aligned camera the only face
        // that qualifies is the opposite face; at corner-views (camera
        // near a +++ vertex) the three rear-axis faces (each at
        // facing≈-0.577) just barely escape the cull, which is correct
        // because they're at the silhouette where bulge keeps them
        // visible. Pre-fix value was -0.25, which was over-aggressive.
        optCamDir.copy(camera.position).normalize()
        optMat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        optFrustum = optFrustumInst.setFromProjectionMatrix(optMat4)
      }

      for (const tile of tiles) {
        const r = storeTileCubeRender(tile, SPHERE_GAP)
        let position = r.position
        let quaternion = r.quaternion
        let clipPlanes = r.clipPlanes
        let faceNormal = FACES[tile.face].normal

        if (sliceQuat && activeAxis && tileInSlice(tile, activeAxis, activeSlice)) {
          // Rotate around origin: position rotates, plane normals rotate,
          // plane constants stay the same (dot products invariant under
          // origin-centered rotation), and the face-normal uniform follows
          // so the sphere projection computes the same per-vertex height.
          position = position.clone().applyQuaternion(sliceQuat)
          quaternion = sliceQuat.clone().multiply(quaternion)
          clipPlanes = clipPlanes.map(p => new THREE.Plane(
            p.normal.clone().applyQuaternion(sliceQuat),
            p.constant,
          ))
          faceNormal = faceNormal.clone().applyQuaternion(sliceQuat)
        }

        let cullGrassThisTile = false
        if (optimize && optFrustum) {
          // Back-face: face-normal vs view-dir. Threshold is intentionally
          // strict (only ~back hemisphere) — sphere-projected side tiles
          // bulge well past the cube's silhouette and are visible from
          // most viewing angles. See setup comment above for the math.
          //
          // Action on back-face: skip GRASS only, NOT the diorama models.
          // Models are cheap and the user wants them rendered everywhere.
          // Grass is the heavy thousands-of-blades instanced pass —
          // skipping it on the hidden hemisphere is the actual win.
          const facing = faceNormal.dot(optCamDir)
          if (facing < -0.6) { cullGrassThisTile = true; optTilesCulled++ }
          // Frustum: tile's projected sphere centre is faceNormal direction
          // (the tile spans ~half a face → ~0.5 rad on the unit sphere;
          // bound radius 0.7 in world units gives slack for tall meshes).
          optSphere.center.copy(faceNormal).multiplyScalar(1.0)
          optSphere.radius = 0.75
          if (!optFrustum.intersectsSphere(optSphere)) { cullGrassThisTile = true; optTilesCulled++ }
          if (!cullGrassThisTile) optTilesRendered++
        }

        // /optimize/ — per-tile mesh visibility. Hide every diorama mesh
        // whose AABB doesn't overlap THIS tile's home patch; show meshes
        // that do, plus the always-visible set (animated subtrees +
        // InstancedMesh grass). Three.js's render path skips invisible
        // meshes — pure perf win, output identical because the hidden
        // meshes would have been clipped out anyway by the 8 clip planes.
        if (optimize && sphereVisRef.current) {
          const homeIdx = tile.homeFace * 4 + tile.homeV * 2 + tile.homeU
          applySphereVisibility(sphereVisRef.current, homeIdx)
          // Per-tile grass shader cull: blades whose iTileIdx differs
          // from this tile collapse to a degenerate point in the vertex
          // shader, skipping the heavy bend / hover-trail math. Grass
          // mesh stays visible (one big InstancedMesh covers all tiles)
          // but renders only blades that belong to THIS tile per pass.
          grassUniforms.uActiveTileIdx.value = homeIdx
          // Back-face / out-of-frustum tile: hide grass + flower
          // instanced meshes specifically (overrides the alwaysVisible
          // flag set by applySphereVisibility). Diorama models stay on.
          if (cullGrassThisTile) {
            for (const m of sphereVisRef.current.grassMeshes) m.visible = false
          }
        }

        gl.clippingPlanes = clipPlanes
        if (su) su.uFaceNormal.value.copy(faceNormal)

        diorama.root.quaternion.copy(quaternion)
        diorama.root.position.copy(position)
        diorama.root.updateMatrix()
        diorama.root.updateMatrixWorld(true)
        gl.render(dScene, camera)
      }

      // After the per-tile pass: restore everything to .visible = true so
      // post-frame consumers (audio anchor traversal on swap, grass
      // groundMesh lookup, animation track binding refresh) see the
      // full scene tree on their next walk. P23 mitigation.
      if (optimize && sphereVisRef.current) {
        restoreSphereVisibility(sphereVisRef.current)
      }
      // Reset grass per-tile cull to "render all blades" so any non-
      // 24-pass render path (preview modes, future single-render hooks)
      // sees a fully-populated meadow. -1 is the disabled sentinel.
      if (optimize) grassUniforms.uActiveTileIdx.value = -1

      if (optimize && import.meta.env.DEV) {
        const nowS = clock.elapsedTime
        if (nowS - optLogLast > 1) {
          optLogLast = nowS
          // eslint-disable-next-line no-console
          console.log(`[optimize] tiles withGrass=${optTilesRendered} grassSuppressed=${optTilesCulled}`)
        }
      }
    } else {
      // Static modes (split, cube) — use pre-computed renders
      const cells = cellsRef.current
      for (let i = 0; i < renders.length; i++) {
        const r = renders[i]
        gl.clippingPlanes = r.clipPlanes

        if (su && cells[i]) {
          su.uFaceNormal.value.copy(FACES[cells[i].face].normal)
        }

        diorama.root.quaternion.copy(r.quaternion)
        diorama.root.position.copy(r.position)
        diorama.root.updateMatrix()
        diorama.root.updateMatrixWorld(true)
        gl.render(dScene, camera)
      }
    }

    gl.clippingPlanes = []
    if (renderingToTarget) {
      gl.setRenderTarget(null)
      if (quadRef.current) quadRef.current.visible = true
    }
    gl.autoClear = prevAutoClear
  }, 1)

  if (mode === 'sphere') {
    return (
      <mesh
        ref={quadRef}
        material={quadMaterial}
        renderOrder={-1000}
        frustumCulled={false}
      >
        <planeGeometry args={[2, 2]} />
      </mesh>
    )
  }
  return null
}
