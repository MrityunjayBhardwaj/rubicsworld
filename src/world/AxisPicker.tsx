import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { usePlanet } from './store'
import type { Axis } from './rotation'

// Picks the ring axis that best matches where the cursor is relative
// to the planet's screen-center, using the current camera orientation.
//
// Why: prior logic used screen-thirds (L/M/R → X/Y/Z), which ignored
// the camera. After the user orbits, the world axes no longer line up
// with left/middle/right on screen, so the axis that activated felt
// disconnected from the cursor position. This projects every world
// axis through the live camera each pointermove and picks by 2D
// geometry.

const ORIGIN = new THREE.Vector3(0, 0, 0)
const WORLD_AXES: { key: Axis; vec: THREE.Vector3 }[] = [
  { key: 'x', vec: new THREE.Vector3(1, 0, 0) },
  { key: 'y', vec: new THREE.Vector3(0, 1, 0) },
  { key: 'z', vec: new THREE.Vector3(0, 0, 1) },
]

const _originNdc = new THREE.Vector3()
const _axisNdc = new THREE.Vector3()

export function AxisPicker() {
  const { camera, gl, size } = useThree()
  const setRingAxis = usePlanet(s => s.setRingAxis)
  const drag = usePlanet(s => s.drag)
  const dragRef = useRef(drag)
  dragRef.current = drag

  useEffect(() => {
    let rafId = 0
    const canvas = gl.domElement

    const pick = (e: PointerEvent) => {
      if (dragRef.current) return

      _originNdc.copy(ORIGIN).project(camera)
      const ox = (_originNdc.x * 0.5 + 0.5) * size.width
      const oy = (1 - (_originNdc.y * 0.5 + 0.5)) * size.height

      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const dx = cx - ox
      const dy = cy - oy
      const clen = Math.hypot(dx, dy)

      let bestAlign = -Infinity
      let bestAlignAxis: Axis = 'x'
      let minProj = Infinity
      let minProjAxis: Axis = 'z'

      for (const a of WORLD_AXES) {
        _axisNdc.copy(a.vec).project(camera)
        const ax = (_axisNdc.x * 0.5 + 0.5) * size.width
        const ay = (1 - (_axisNdc.y * 0.5 + 0.5)) * size.height
        const adx = ax - ox
        const ady = ay - oy
        const alen = Math.hypot(adx, ady)

        if (alen < minProj) {
          minProj = alen
          minProjAxis = a.key
        }

        if (clen > 1 && alen > 1) {
          // |cos| because axis lines are directionless (slice index
          // differentiates the halves, not the sign of the screen
          // vector).
          const align = Math.abs(adx * dx + ady * dy) / (alen * clen)
          if (align > bestAlign) {
            bestAlign = align
            bestAlignAxis = a.key
          }
        }
      }

      // If the cursor is much closer to the planet center than the
      // largest axis projection, prefer the axis pointing toward/away
      // from the camera (Z-ish in the default view). Otherwise go by
      // 2D alignment.
      const axis = clen < minProj * 0.5 ? minProjAxis : bestAlignAxis
      setRingAxis(axis)
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
  }, [camera, gl, size.width, size.height, setRingAxis])

  return null
}
