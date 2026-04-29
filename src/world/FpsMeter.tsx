import { useEffect, useRef } from 'react'

/**
 * Lightweight FPS / frame-time HUD. Always visible at top-left so we can
 * eyeball perf across the default route vs `/optimize/`.
 *
 * Counts frames between rAF ticks and refreshes the DOM at 500ms cadence
 * (so the digits don't jitter every frame). Writes via ref — no React
 * re-renders per frame.
 */
export function FpsMeter() {
  const elRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let raf = 0
    let frames = 0
    let lastFlush = performance.now()
    let lastFrame = lastFlush
    let worstMs = 0

    const tick = () => {
      const now = performance.now()
      const dt = now - lastFrame
      lastFrame = now
      if (dt > worstMs) worstMs = dt
      frames++
      const sinceFlush = now - lastFlush
      if (sinceFlush >= 500 && elRef.current) {
        const fps = (frames * 1000) / sinceFlush
        const avgMs = sinceFlush / frames
        elRef.current.textContent =
          `${fps.toFixed(0)} fps · ${avgMs.toFixed(1)} ms (worst ${worstMs.toFixed(1)})`
        frames = 0
        lastFlush = now
        worstMs = 0
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      ref={elRef}
      style={{
        position: 'fixed',
        top: 10,
        left: 10,
        zIndex: 1001,
        padding: '4px 8px',
        font: '11px/1.2 ui-monospace, Menlo, Consolas, monospace',
        color: '#0f0',
        background: 'rgba(0,0,0,0.55)',
        borderRadius: 4,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      — fps —
    </div>
  )
}
