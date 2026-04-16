import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { usePlanet } from './store'
import type { Axis } from './rotation'

// Ring axis/slice picking.
//
// Two regimes:
// 1. Cursor is OVER the planet (ray hits the unit sphere).
//    Decide from the 3D hit point — because the user's intuition is
//    3D, not screen-2D.
//    - Hit on a ±X or ±Z face (tile's face axis is X or Z): the
//      natural rotation goes AROUND the Y axis (horizontal belt
//      containing the hovered tile). Slice = sign of hit.y.
//    - Hit on a ±Y face (top/bottom): no single obvious choice
//      between X and Z. Fall through to screen-direction picking,
//      restricted to {X, Z}, and pick slice from the chosen axis
//      component of the hit.
// 2. Cursor is in empty space. Use the projected-axis screen
//    direction heuristic; don't touch slice.

const ORIGIN = new THREE.Vector3(0, 0, 0)
const SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1)

const AXIS_VECS: { key: Axis; vec: THREE.Vector3 }[] = [
  { key: 'x', vec: new THREE.Vector3(1, 0, 0) },
  { key: 'y', vec: new THREE.Vector3(0, 1, 0) },
  { key: 'z', vec: new THREE.Vector3(0, 0, 1) },
]

const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
const _hit = new THREE.Vector3()
const _originNdc = new THREE.Vector3()
const _axisNdc = new THREE.Vector3()

export function AxisPicker() {
  const { camera, gl, size } = useThree()
  const setRing = usePlanet(s => s.setRing)
  const setRingAxis = usePlanet(s => s.setRingAxis)
  const drag = usePlanet(s => s.drag)
  const dragRef = useRef(drag)
  dragRef.current = drag

  useEffect(() => {
    let rafId = 0
    const canvas = gl.domElement

    function pickByScreen(allowed: readonly Axis[], cx: number, cy: number): Axis {
      _originNdc.copy(ORIGIN).project(camera)
      const ox = (_originNdc.x * 0.5 + 0.5) * size.width
      const oy = (1 - (_originNdc.y * 0.5 + 0.5)) * size.height
      const dx = cx - ox
      const dy = cy - oy
      const clen = Math.hypot(dx, dy)

      let bestAlign = -Infinity
      let bestAlignAxis: Axis = allowed[0]
      let minProj = Infinity
      let minProjAxis: Axis = allowed[0]

      for (const av of AXIS_VECS) {
        if (!allowed.includes(av.key)) continue
        _axisNdc.copy(av.vec).project(camera)
        const ax = (_axisNdc.x * 0.5 + 0.5) * size.width
        const ay = (1 - (_axisNdc.y * 0.5 + 0.5)) * size.height
        const adx = ax - ox
        const ady = ay - oy
        const alen = Math.hypot(adx, ady)

        if (alen < minProj) {
          minProj = alen
          minProjAxis = av.key
        }
        if (clen > 1 && alen > 1) {
          const align = Math.abs(adx * dx + ady * dy) / (alen * clen)
          if (align > bestAlign) {
            bestAlign = align
            bestAlignAxis = av.key
          }
        }
      }
      return clen < minProj * 0.5 ? minProjAxis : bestAlignAxis
    }

    const pick = (e: PointerEvent) => {
      if (dragRef.current) return

      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      // 1) Raycast against the planet's unit sphere
      _ndc.set((cx / size.width) * 2 - 1, -((cy / size.height) * 2 - 1))
      _ray.setFromCamera(_ndc, camera)
      const hasHit = !!_ray.ray.intersectSphere(SPHERE, _hit)

      if (hasHit) {
        const ax = Math.abs(_hit.x)
        const ay = Math.abs(_hit.y)
        const az = Math.abs(_hit.z)
        if (ay > ax && ay > az) {
          // Hit on +Y or -Y face: pick X or Z from the screen heuristic
          const axis = pickByScreen(['x', 'z'] as const, cx, cy)
          const slice =
            axis === 'x' ? (_hit.x > 0 ? 1 : 0) : (_hit.z > 0 ? 1 : 0)
          setRing(axis, slice)
        } else {
          // Hit on a side face — the natural motion wraps the Y belt
          setRing('y', _hit.y > 0 ? 1 : 0)
        }
        return
      }

      // 2) No hit: screen-direction heuristic picks axis, slice stays
      setRingAxis(pickByScreen(['x', 'y', 'z'] as const, cx, cy))
    }

    const onMove = (e: PointerEvent) => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        pick(e)
      })
    }

    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [camera, gl, size.width, size.height, setRing, setRingAxis])

  return null
}
