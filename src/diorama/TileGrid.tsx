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
import { buildDiorama, HALF_W, HALF_H, type DioramaScene } from './buildDiorama'
import { COLS, ROWS, CELL, cellFace, FACE_TO_BLOCK_TL } from './DioramaGrid'
import { FACES, type FaceIndex } from '../world/faces'
import { usePlanet } from '../world/store'
import { AXIS_VEC, tileInSlice, type Axis } from '../world/rotation'
import type { Tile } from '../world/tile'

const SLICE_ROT_MS = 380

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

/** Convert store tile home position to grid (col, row) → diorama homeX/homeZ */
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
  const vOff = (localV - 0.5) * CELL
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
        localV: row % 2,
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

  // Cell center on cube face
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
      const vOff = (cell.localV - 0.5) * CELL
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
  material.onBeforeCompile = (shader) => {
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
      // Cube-space position for clipping (BEFORE sphere projection)
      #if NUM_CLIPPING_PLANES > 0
        vClipPosition = -(modelViewMatrix * vec4(transformed, 1.0)).xyz;
      #endif

      // Sphere projection with bezier height curve
      vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
      vec3 wp = worldPos.xyz;
      float faceDistance = dot(wp, uFaceNormal);
      float rawHeight = faceDistance - 1.0;

      // Apply bezier curve to normalized height
      float normalizedH = clamp(rawHeight / uMaxHeight, 0.0, 1.0);
      float curvedH = rawHeight <= 0.0 ? rawHeight : evalHeightCurve(normalizedH) * uMaxHeight;

      vec3 basePoint = wp - rawHeight * uFaceNormal;
      vec3 sphereBase = normalize(basePoint);
      vec3 spherePos = sphereBase * (1.0 + curvedH);

      // Correct normals for sphere curvature
      #ifdef USE_NORMAL
        vec3 sphereNormal = normalize(sphereBase);
        // Ground-level geometry follows the sphere, tall objects keep their own normals.
        float normalBlend = clamp(1.0 - normalizedH * 2.0, 0.0, 1.0);
        vNormal = normalize(mix(vNormal, normalMatrix * sphereNormal, normalBlend));
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

  material.customProgramCacheKey = () => 'sphereProjectionAdditive'
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

    const diorama = buildDiorama()
    dioramaRef.current = diorama

    // Disable frustum culling — the sphere projection shader moves vertices
    // to positions that differ from the bounding sphere Three.js computes
    // from cube-space geometry. Without this, objects near the screen edge
    // get incorrectly culled.
    diorama.root.traverse(child => { child.frustumCulled = false })

    const dScene = new THREE.Scene()
    dScene.add(diorama.root)
    dScene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(3, 4, 2)
    dScene.add(dir)
    dioramaSceneRef.current = dScene

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

    return () => {
      gl.localClippingEnabled = false
      gl.clippingPlanes = []
      diorama.root.traverse(child => {
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
