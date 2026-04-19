import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { usePlanet } from './store'
import { centroidToFaceUV, tileCentroid, type Axis, type Direction, type Move } from './rotation'
import { FACES, type FaceDef, type FaceIndex } from './faces'
import { hudUniforms } from '../diorama/buildDiorama'

// Pointer input lives here because both onPlanet tracking and drag-axis
// resolution need the live camera for raycasting.
//
// Interaction model:
// - pointermove (no drag): raycast to the planet's unit sphere. If the ray
//   hits the sphere OR a padded sphere around the (not-yet-visible) ring
//   area, set onPlanet=true. Otherwise false.
// - pointerdown (left button, onPlanet): raycast for hit point, stash a
//   pending drag. Stop propagation so OrbitControls doesn't orbit.
// - pointermove (pending drag): once the drag displacement exceeds
//   DRAG_COMMIT_PX, the drag *direction* picks the rotation axis — the
//   axis whose tangent at the hit point best aligns with the drag vector
//   in screen space. Slice = sign of the hit component along that axis.
//   Commit by calling beginDragAt.
// - pointermove (committed drag): project drag vector onto the stored
//   tangent direction to get a signed angle in radians.
// - pointerup: endDrag (commit to nearest ±π/2 or snap back).

const ORIGIN = new THREE.Vector3(0, 0, 0)
const PLANET_SPHERE = new THREE.Sphere(ORIGIN, 1)
const RING_RADIUS_PAD = 1.42

const AXIS_VECS: { key: Axis; vec: THREE.Vector3 }[] = [
  { key: 'x', vec: new THREE.Vector3(1, 0, 0) },
  { key: 'y', vec: new THREE.Vector3(0, 1, 0) },
  { key: 'z', vec: new THREE.Vector3(0, 0, 1) },
]

const DRAG_COMMIT_PX = 10
const DRAG_PX_PER_RADIAN = 180

const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
const _hit = new THREE.Vector3()
const _ringSphere = new THREE.Sphere(new THREE.Vector3(), RING_RADIUS_PAD)
const _tangentWorld = new THREE.Vector3()
const _hitEnd = new THREE.Vector3()
const _proj = new THREE.Vector3()
const _hitScreen = new THREE.Vector2()
const _endScreen = new THREE.Vector2()

function project3ToScreen(
  v: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
  out: THREE.Vector2,
) {
  _proj.copy(v).project(camera)
  out.set((_proj.x * 0.5 + 0.5) * width, (1 - (_proj.y * 0.5 + 0.5)) * height)
  return out
}

type PendingDrag =
  | { kind: 'waiting'; startX: number; startY: number; hit: THREE.Vector3 }
  | {
      kind: 'committed'
      startX: number
      startY: number
      tangent: THREE.Vector2 // unit, in screen pixels
    }

/** Map a sphere hit point to the (face, u, v) of the tile it lies in.
 *  The hit is on the unit sphere; project onto the cube by dividing through
 *  the max-abs component, then use centroidToFaceUV to pick the tile's cell.
 *  Returns null for degenerate (origin) inputs. */
function sphereHitToTile(hit: THREE.Vector3): { face: FaceIndex; u: number; v: number } | null {
  const ax = Math.abs(hit.x), ay = Math.abs(hit.y), az = Math.abs(hit.z)
  const m = Math.max(ax, ay, az)
  if (m < 1e-6) return null
  const cube = new THREE.Vector3(hit.x / m, hit.y / m, hit.z / m)
  return centroidToFaceUV(cube)
}

/** Given a key + hovered face-local axes + tile centroid, derive the (axis,
 *  slice, dir) Move. The 6 keys map to the 3 face-local axes × 2 directions:
 *    Q/E  → rotate around face.normal (Q = CCW looking AT the face, E = CW)
 *    W/S  → rotate around face.right  (W = tilt top away, S = tilt top toward)
 *    A/D  → rotate around face.up     (A = left, D = right)
 *  Slice is forced by the tile's world-axis component — there's only one
 *  slice containing the hovered tile along each world axis. */
function moveFromKey(key: string, face: FaceDef, tileUV: { u: number; v: number }): Move | null {
  const centroid = tileCentroid(face.index, tileUV.u, tileUV.v)
  const resolve = (dir: THREE.Vector3): { axis: Axis; worldSign: 1 | -1 } => {
    const ax = Math.abs(dir.x), ay = Math.abs(dir.y)
    let axis: Axis
    if (ax > 0.5) axis = 'x'
    else if (ay > 0.5) axis = 'y'
    else axis = 'z'
    const worldSign = (dir[axis] > 0 ? 1 : -1) as 1 | -1
    return { axis, worldSign }
  }
  const sliceOf = (axis: Axis): number => (centroid[axis] > 0 ? 1 : 0)

  switch (key) {
    case 'q':
    case 'e': {
      const { axis, worldSign } = resolve(face.normal)
      // Q = CCW from viewer → dir = -worldSign; E = CW → dir = +worldSign.
      const base = key === 'q' ? -1 : 1
      return { axis, slice: sliceOf(axis), dir: (base * worldSign) as Direction }
    }
    case 'w':
    case 's': {
      const { axis, worldSign } = resolve(face.right)
      // W tilts the face's top away from viewer; equivalent to rotating the
      // slice +90° around face.right (right-hand rule: up → normal).
      const base = key === 'w' ? 1 : -1
      return { axis, slice: sliceOf(axis), dir: (base * worldSign) as Direction }
    }
    case 'a':
    case 'd': {
      const { axis, worldSign } = resolve(face.up)
      // D rotates the face's right edge "down" (right-hand rule: normal → right).
      const base = key === 'd' ? 1 : -1
      return { axis, slice: sliceOf(axis), dir: (base * worldSign) as Direction }
    }
  }
  return null
}

export function Interaction() {
  const { camera, gl, size } = useThree()
  const setOnPlanet = usePlanet(s => s.setOnPlanet)
  const setHoveredTile = usePlanet(s => s.setHoveredTile)
  const beginDragAt = usePlanet(s => s.beginDragAt)
  const updateDrag = usePlanet(s => s.updateDrag)
  const endDrag = usePlanet(s => s.endDrag)

  const pending = useRef<PendingDrag | null>(null)
  const onPlanetRef = useRef(false)

  useEffect(() => {
    const canvas = gl.domElement
    const width = () => size.width
    const height = () => size.height

    function raycastHit(cx: number, cy: number, out: THREE.Vector3): boolean {
      _ndc.set((cx / width()) * 2 - 1, -((cy / height()) * 2 - 1))
      _ray.setFromCamera(_ndc, camera)
      return !!_ray.ray.intersectSphere(PLANET_SPHERE, out)
    }

    function rayMissesPlanetButNearRing(): boolean {
      // Ring's "near zone": a sphere at origin big enough to cover any
      // possible ring orientation. Keeps onPlanet true when the cursor
      // hovers out just past the sphere silhouette.
      _ringSphere.center.copy(ORIGIN)
      return _ray.ray.intersectsSphere(_ringSphere)
    }

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      // Committed drag updates
      if (pending.current) {
        const dx = e.clientX - pending.current.startX
        const dy = e.clientY - pending.current.startY

        if (pending.current.kind === 'waiting') {
          const dist = Math.hypot(dx, dy)
          if (dist < DRAG_COMMIT_PX) return

          const hit = pending.current.hit
          let bestAxis: Axis = 'y'
          let bestScore = -Infinity
          let bestTangent = new THREE.Vector2(1, 0)

          project3ToScreen(hit, camera, width(), height(), _hitScreen)
          for (const av of AXIS_VECS) {
            // World tangent = axis × hit — the CCW-rotation velocity of
            // the hit point. Keep the unit vector in THIS mathematical
            // direction; don't flip it to match drag. The sign of the
            // projection onto it is what encodes CW vs CCW.
            _tangentWorld.crossVectors(av.vec, hit)
            if (_tangentWorld.lengthSq() < 1e-8) continue
            _tangentWorld.normalize()
            _hitEnd.copy(hit).addScaledVector(_tangentWorld, 0.1)
            project3ToScreen(_hitEnd, camera, width(), height(), _endScreen)
            const tx = _endScreen.x - _hitScreen.x
            const ty = _endScreen.y - _hitScreen.y
            const tlen = Math.hypot(tx, ty)
            if (tlen < 0.3) continue // axis nearly view-aligned

            const dot = tx * dx + ty * dy
            const score = Math.abs(dot) / (tlen * dist)
            if (score > bestScore) {
              bestScore = score
              bestAxis = av.key
              bestTangent = new THREE.Vector2(tx / tlen, ty / tlen)
            }
          }

          const hitComp =
            bestAxis === 'x' ? hit.x : bestAxis === 'y' ? hit.y : hit.z
          const slice = hitComp > 0 ? 1 : 0

          beginDragAt(bestAxis, slice)

          pending.current = {
            kind: 'committed',
            startX: pending.current.startX,
            startY: pending.current.startY,
            tangent: bestTangent,
          }
          // fall through to apply initial angle
        }

        if (pending.current.kind === 'committed') {
          const proj = dx * pending.current.tangent.x + dy * pending.current.tangent.y
          updateDrag(proj / DRAG_PX_PER_RADIAN)
        }
        return
      }

      // No drag in progress — update onPlanet for orbit gating
      const tgt = e.target as HTMLElement | null
      if (tgt && typeof tgt.closest === 'function' && tgt.closest('[id^="leva"]')) {
        setOnPlanet(false)
        onPlanetRef.current = false
        setHoveredTile(null)
        hudUniforms.uHudCursorActive.value = 0
        return
      }
      if (cx < 0 || cy < 0 || cx > width() || cy > height()) {
        setOnPlanet(false)
        onPlanetRef.current = false
        setHoveredTile(null)
        hudUniforms.uHudCursorActive.value = 0
        return
      }

      const hit = raycastHit(cx, cy, _hit)
      const near = hit || rayMissesPlanetButNearRing()
      setOnPlanet(near)
      onPlanetRef.current = near
      // Publish hovered tile for the keyboard-rotation hybrid. Only set when
      // the ray actually hits the planet surface; the padded-ring region isn't
      // a tile, so pressing a key there would be ambiguous.
      setHoveredTile(hit ? sphereHitToTile(_hit) : null)
      // Publish cursor world-pos to the HUD shader directly (no store churn
      // per pointermove). When off-planet, mark cursor inactive so the
      // terrain's gaussian proximity term zeros out.
      if (hit) {
        hudUniforms.uHudCursor.value.copy(_hit)
        hudUniforms.uHudCursorActive.value = 1
      } else {
        hudUniforms.uHudCursorActive.value = 0
      }
    }

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const tgt = e.target as HTMLElement | null
      if (tgt && tgt.closest('[id^="leva"]')) return

      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const hitPoint = new THREE.Vector3()
      const hit = raycastHit(cx, cy, hitPoint)
      if (!hit) return // let OrbitControls take it for camera orbit

      e.stopPropagation()
      pending.current = {
        kind: 'waiting',
        startX: e.clientX,
        startY: e.clientY,
        hit: hitPoint,
      }
    }

    const onUp = () => {
      if (!pending.current) return
      const wasCommitted = pending.current.kind === 'committed'
      pending.current = null
      if (wasCommitted) void endDrag()
    }

    const onKey = (e: KeyboardEvent) => {
      // Ignore modifiers (let browser shortcuts pass) and typing contexts.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return

      const key = e.key.toLowerCase()
      if (!['q', 'w', 'e', 'a', 's', 'd'].includes(key)) return

      const s = usePlanet.getState()
      if (s.anim || s.drag) return // rotation already in flight
      const ht = s.hoveredTile
      if (!ht) return // nothing hovered

      const move = moveFromKey(key, FACES[ht.face], { u: ht.u, v: ht.v })
      if (!move) return

      e.preventDefault()
      void s.rotateAnimated(move)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [camera, gl, size.width, size.height, setOnPlanet, setHoveredTile, beginDragAt, updateDrag, endDrag])

  return null
}
