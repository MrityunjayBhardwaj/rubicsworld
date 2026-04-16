import { useEffect, useRef } from 'react'
import { usePlanet } from './world/store'

const DRAG_PX_PER_RADIAN = 180 // ~π radians per 565 px of horizontal travel

// Axis-from-cursor lives in world/AxisPicker.tsx (inside Canvas — it
// needs the live camera). Drag / keyboard / scroll stay here.
export function InputHandler() {
  const setRingAxis = usePlanet(s => s.setRingAxis)
  const cycleRingSlice = usePlanet(s => s.cycleRingSlice)
  const beginDrag = usePlanet(s => s.beginDrag)
  const updateDrag = usePlanet(s => s.updateDrag)
  const endDrag = usePlanet(s => s.endDrag)

  const dragStart = useRef<{ x: number; y: number } | null>(null)

  // Scroll wheel cycles slice (N=2 → toggle)
  useEffect(() => {
    let last = 0
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 20) return
      const now = performance.now()
      if (now - last < 180) return
      last = now
      cycleRingSlice()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [cycleRingSlice])

  // Keyboard: 1/2/3 = axis; space = cycle slice
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === '1') setRingAxis('x')
      else if (e.key === '2') setRingAxis('y')
      else if (e.key === '3') setRingAxis('z')
      else if (e.key === ' ' || e.key === 'Tab') {
        e.preventDefault()
        cycleRingSlice()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setRingAxis, cycleRingSlice])

  // Drag: primary pointer button, left-right motion rotates the active slice.
  // Registered with capture=true so we run BEFORE OrbitControls (which is on
  // the canvas element). If we claim the event (cursor on planet), we
  // stopPropagation → OrbitControls never sees it. Otherwise we do nothing
  // and OrbitControls rotates the camera as its default LEFT action.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const tgt = e.target as HTMLElement | null
      if (tgt && tgt.closest('[id^="leva"]')) return
      const { onPlanet } = usePlanet.getState()
      if (!onPlanet) return // let OrbitControls handle camera orbit
      e.stopPropagation()
      dragStart.current = { x: e.clientX, y: e.clientY }
      beginDrag()
    }
    const onMove = (e: PointerEvent) => {
      if (!dragStart.current) return
      const dx = e.clientX - dragStart.current.x
      updateDrag(dx / DRAG_PX_PER_RADIAN)
    }
    const onUp = () => {
      if (!dragStart.current) return
      dragStart.current = null
      void endDrag()
    }
    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [beginDrag, updateDrag, endDrag])

  return null
}
