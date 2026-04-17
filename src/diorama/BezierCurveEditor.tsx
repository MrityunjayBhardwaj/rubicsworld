/**
 * Draggable cubic bezier curve editor.
 * Fixed endpoints: P0=(0,0), P3=(1,1).
 * Two draggable control handles: P1=(cx1,cy1), P2=(cx2,cy2).
 * Output: the 4 control values as a callback.
 */

import { useRef, useEffect, useCallback, useState } from 'react'

const SIZE = 180
const PAD = 20
const INNER = SIZE - PAD * 2

interface Props {
  cx1: number
  cy1: number
  cx2: number
  cy2: number
  onChange: (cx1: number, cy1: number, cx2: number, cy2: number) => void
}

function toCanvas(v: number): number {
  return PAD + v * INNER
}
function toCanvasY(v: number): number {
  return PAD + (1 - v) * INNER // Y is flipped
}
function fromCanvas(px: number): number {
  return Math.max(0, Math.min(1, (px - PAD) / INNER))
}
function fromCanvasY(px: number): number {
  return Math.max(-0.5, Math.min(2, 1 - (px - PAD) / INNER))
}

export function BezierCurveEditor({ cx1, cy1, cx2, cy2, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dragging, setDragging] = useState<null | 1 | 2>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = SIZE * dpr
    canvas.height = SIZE * dpr
    ctx.scale(dpr, dpr)

    // Background
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, SIZE, SIZE)

    // Grid
    ctx.strokeStyle = '#2a2a4a'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const v = i / 4
      ctx.beginPath()
      ctx.moveTo(toCanvas(v), toCanvasY(0))
      ctx.lineTo(toCanvas(v), toCanvasY(1))
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(toCanvas(0), toCanvasY(v))
      ctx.lineTo(toCanvas(1), toCanvasY(v))
      ctx.stroke()
    }

    // Linear reference (diagonal)
    ctx.strokeStyle = '#3a3a5a'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(toCanvas(0), toCanvasY(0))
    ctx.lineTo(toCanvas(1), toCanvasY(1))
    ctx.stroke()
    ctx.setLineDash([])

    // Bezier curve
    ctx.strokeStyle = '#ff9933'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(toCanvas(0), toCanvasY(0))
    ctx.bezierCurveTo(
      toCanvas(cx1), toCanvasY(cy1),
      toCanvas(cx2), toCanvasY(cy2),
      toCanvas(1), toCanvasY(1),
    )
    ctx.stroke()

    // Control handles — lines from endpoints to control points
    ctx.strokeStyle = '#ff993366'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(toCanvas(0), toCanvasY(0))
    ctx.lineTo(toCanvas(cx1), toCanvasY(cy1))
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(toCanvas(1), toCanvasY(1))
    ctx.lineTo(toCanvas(cx2), toCanvasY(cy2))
    ctx.stroke()

    // Control points
    for (const [x, y, active] of [[cx1, cy1, dragging === 1], [cx2, cy2, dragging === 2]] as const) {
      ctx.fillStyle = active ? '#ffcc00' : '#ff6600'
      ctx.beginPath()
      ctx.arc(toCanvas(x), toCanvasY(y), 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Endpoints
    for (const [x, y] of [[0, 0], [1, 1]]) {
      ctx.fillStyle = '#888'
      ctx.beginPath()
      ctx.arc(toCanvas(x), toCanvasY(y), 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [cx1, cy1, cx2, cy2, dragging])

  useEffect(() => { draw() }, [draw])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    // Check which control point is closest
    const d1 = Math.hypot(mx - toCanvas(cx1), my - toCanvasY(cy1))
    const d2 = Math.hypot(mx - toCanvas(cx2), my - toCanvasY(cy2))

    if (d1 < 15 && d1 < d2) {
      setDragging(1)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } else if (d2 < 15) {
      setDragging(2)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }
  }, [cx1, cy1, cx2, cy2])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const x = fromCanvas(mx)
    const y = fromCanvasY(my)

    if (dragging === 1) onChange(x, y, cx2, cy2)
    else onChange(cx1, cy1, x, y)
  }, [dragging, cx1, cy1, cx2, cy2, onChange])

  const handlePointerUp = useCallback(() => {
    setDragging(null)
  }, [])

  return (
    <div style={{
      position: 'fixed', bottom: 16, left: 16, zIndex: 1000,
      background: '#1a1a2e', borderRadius: 8, padding: 8,
      border: '1px solid #3a3a5a', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    }}>
      <div style={{ color: '#888', fontSize: 10, marginBottom: 4, fontFamily: 'monospace' }}>
        Height Curve
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: SIZE, height: SIZE, cursor: dragging ? 'grabbing' : 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <div style={{ color: '#666', fontSize: 9, marginTop: 4, fontFamily: 'monospace' }}>
        P1({cx1.toFixed(2)},{cy1.toFixed(2)}) P2({cx2.toFixed(2)},{cy2.toFixed(2)})
      </div>
    </div>
  )
}
