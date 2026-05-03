import { useEffect, useState } from 'react'
import { usePlanet } from './store'

/**
 * Top-left mm:ss stopwatch — runs while gamePhase==='playing'.
 *
 * Reads playStartedAt straight from the store. The timer starts on
 * level-boot (autoStart path in store init) and stops when StatsOverlay
 * opens. Ticks every 250 ms — overkill for second-resolution display
 * but cheap and avoids the 500–999 ms drift you'd see with a 1 s tick.
 *
 * Hidden while the menu is open or the stats overlay is up — the timer
 * still runs (markSolved reads playStartedAt directly), but the HUD
 * stops cluttering the chrome the user is interacting with.
 */
export function Stopwatch() {
  const gamePhase = usePlanet(s => s.gamePhase)
  const playStartedAt = usePlanet(s => s.playStartedAt)
  const statsOverlayOpen = usePlanet(s => s.statsOverlayOpen)
  const menuOpen = usePlanet(s => s.menuOpen)
  const [now, setNow] = useState(() => performance.now())

  const visible = gamePhase === 'playing' && !statsOverlayOpen && !menuOpen && playStartedAt != null

  useEffect(() => {
    if (!visible) return
    const id = window.setInterval(() => setNow(performance.now()), 250)
    return () => window.clearInterval(id)
  }, [visible])

  if (!visible || playStartedAt == null) return null
  return <div style={overlayStyle}>{formatTime(now - playStartedAt)}</div>
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const mm = Math.floor(totalSec / 60).toString().padStart(2, '0')
  const ss = (totalSec % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 18,
  left: 20,
  zIndex: 1500, // below MenuOverlay (2000) so a pause overlay covers it
  pointerEvents: 'none',
  fontFamily: '"Finger Paint", "Iowan Old Style", Georgia, serif',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 22,
  letterSpacing: '0.08em',
  color: '#f5ead3',
  opacity: 0.78,
  textShadow: '0 1px 8px rgba(0,0,0,0.55)',
  userSelect: 'none',
}
