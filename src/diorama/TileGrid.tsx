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
import { buildGrass, grassRefs } from './buildGrass'
import { loadGlbDiorama } from './loadGlbDiorama'
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

  const clipPlanes = [
    new THREE.Plane(r.clone(), halfCell - rDot),
    new THREE.Plane(r.clone().negate(), halfCell + rDot),
    new THREE.Plane(u.clone(), halfCell - uDot),
    new THREE.Plane(u.clone().negate(), halfCell + uDot),
    new THREE.Plane(n.clone().sub(r.clone()).normalize(), 0),
    new THREE.Plane(n.clone().add(r.clone()).normalize(), 0),
    new THREE.Plane(n.clone().sub(u.clone()).normalize(), 0),
    new THREE.Plane(n.clone().add(u.clone()).normalize(), 0),
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
  const sphereTarget = useFBO()

  const quadMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(uMap, vUv);
      }
    `,
    uniforms: { uMap: { value: sphereTarget.texture } },
    depthTest: false,
    depthWrite: false,
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
    // mesh (see globalTerrainScene below) — omit it from the per-tile root
    // to avoid double-drawing and so per-tile clip-plane rasterization gaps
    // simply expose the continuous global sphere underneath.
    let diorama: DioramaScene = glbPath
      ? { root: new THREE.Group(), update: () => {} }
      : buildDiorama({ includeTerrain: mode !== 'sphere' })
    dioramaRef.current = diorama

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
    if (mode === 'sphere') {
      const terrainMesh = buildSphereTerrain()
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

    // Pre-compute per-cell transforms + clip planes
    const gap = mode === 'split' ? SPLIT_GAP : CUBE_GAP
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
            ? buildDiorama({ includeTerrain: mode !== 'sphere' })
            : null
        )
        if (!next) return  // keep current scene on failed reload
        const prev = dioramaRef.current
        if (prev) {
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
        }
        diorama = next
        dioramaRef.current = next
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
      // Ensure matrices are current — newly built objects may have matrix
      // auto-update disabled upstream, and the exporter serialises
      // matrixWorld as-is.
      throwaway.root.updateMatrixWorld(true)
      const exporter = new GLTFExporter()
      const arrayBuffer = await new Promise<ArrayBuffer | null>(resolve => {
        exporter.parse(
          throwaway.root,
          result => {
            if (result instanceof ArrayBuffer) resolve(result)
            else resolve(null)   // { binary: true } guarantees ArrayBuffer
          },
          err => { console.error('[diorama] GLTFExporter failed:', err); resolve(null) },
          { binary: true, animations: [] },
        )
      })
      // Dispose the throwaway to keep memory clean.
      throwaway.root.traverse(c => {
        const m = c as THREE.Mesh
        if (!m.isMesh) return
        m.geometry?.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach(x => x.dispose())
        else mat?.dispose()
      })
      if (!arrayBuffer) return null
      return new Blob([arrayBuffer], { type: 'model/gltf-binary' })
    }

    // Swap-rebuild grass using a user-painted mask (or clear back to AABB
    // exclusion). Disposes the previous grass InstancedMesh, asks buildGrass
    // for a new one driven by pixel sampling, then re-applies the sphere
    // projection patch (idempotent guard skips already-patched props and only
    // touches the new grass material).
    grassRefs.rebuildWithMask = (mask) => {
      const diorama = dioramaRef.current
      if (!diorama) return
      // Persist across hot-reload swaps: loadGlbDiorama reads activeMask
      // and forwards it to buildGrass. null here = clear (drop back to
      // AABB exclusion). Store BEFORE the rebuild so the new grass uses it.
      grassRefs.activeMask = mask
      // Dispose every previous meadow mesh (grass + 4 flowers) before building
      // fresh ones. The old handles live in grassRefs.meadowMeshes.
      for (const old of grassRefs.meadowMeshes) {
        old.parent?.remove(old)
        old.geometry.dispose()
        const m = old.material
        if (Array.isArray(m)) m.forEach(x => x.dispose())
        else m.dispose()
      }
      const grass = buildGrass(diorama.root, { maskImage: mask ?? undefined })
      for (const mesh of grass.meshes) diorama.root.add(mesh)
      if (mode === 'sphere' && sphereUniformsRef.current) {
        patchSceneForSphere(diorama.root, sphereUniformsRef.current)
      }
      diorama.root.updateMatrixWorld(true)
      // Re-apply Leva state (density / flower split / colours) since the new
      // meshes came in with buildGrass defaults.
      grassRefs.reapplyControls?.()
    }

    return () => {
      gl.localClippingEnabled = false
      gl.clippingPlanes = []
      grassRefs.captureTopView = null
      grassRefs.rebuildWithMask = null
      grassRefs.saveDiorama = null
      ;(dioramaRef as unknown as { _cancelSwap?: () => void })._cancelSwap?.()
      ;(dioramaRef as unknown as { _offHmr?: () => void })._offHmr?.()
      // Dispose whatever root is LIVE in the ref (may be the stub, the
      // imperative fallback, or the loaded glb — all same disposal shape).
      const live = dioramaRef.current ?? diorama
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

        gl.clippingPlanes = clipPlanes
        if (su) su.uFaceNormal.value.copy(faceNormal)

        diorama.root.quaternion.copy(quaternion)
        diorama.root.position.copy(position)
        diorama.root.updateMatrix()
        diorama.root.updateMatrixWorld(true)
        gl.render(dScene, camera)
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
