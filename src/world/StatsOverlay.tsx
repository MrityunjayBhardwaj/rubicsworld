import { useEffect } from 'react'
import { usePlanet } from './store'
import { getPlanet, getNextPlanet } from './planetManifest'

/**
 * Post-solve stats overlay (issue #48 Phase B).
 *
 * Visibility driven by `statsOverlayOpen`. The trigger flow:
 *   `applyRotation` detects a fresh solve and dispatches `'planet:settled'`.
 *   This component listens for that event and calls `markSolved` IF
 *   `gamePhase === 'playing' && introPhase === 'done'` — gating skips the
 *   tutorial's guided 3-move solve (that completes before the player has
 *   actually started a real run).
 *
 * The Continue button calls `advancePlanet`, which either swaps to the next
 * planet (Phase C wires asset crossfade in) or — when no next planet exists —
 * falls back to the title screen as a placeholder end-of-progression flow.
 */
export function StatsOverlay() {
  const statsOverlayOpen = usePlanet(s => s.statsOverlayOpen)
  const lastSolveTimeMs = usePlanet(s => s.lastSolveTimeMs)
  const currentPlanetSlug = usePlanet(s => s.currentPlanetSlug)
  const advancePlanet = usePlanet(s => s.advancePlanet)
  const markSolved = usePlanet(s => s.markSolved)

  useEffect(() => {
    const onSettled = () => {
      const s = usePlanet.getState()
      if (s.gamePhase !== 'playing') return
      // Tutorial completion settles the puzzle too — only count the player's
      // own solve, which always lands after introPhase has reached 'done'.
      if (s.introPhase !== 'done') return
      markSolved(s.currentPlanetSlug)
    }
    window.addEventListener('planet:settled', onSettled)
    return () => window.removeEventListener('planet:settled', onSettled)
  }, [markSolved])

  if (!statsOverlayOpen) return null

  const planet = getPlanet(currentPlanetSlug)
  const planetName = planet?.name ?? currentPlanetSlug
  const next = getNextPlanet(currentPlanetSlug)
  const continueLabel = next ? 'Continue' : 'Return to title'

  return (
    <div style={overlayBase}>
      <div style={card}>
        <div style={eyebrow}>Solved</div>
        <h2 style={planetText}>{planetName}</h2>
        <div style={timeText}>{formatTime(lastSolveTimeMs)}</div>
        <button style={primaryButton} onClick={advancePlanet} autoFocus>
          {continueLabel}
        </button>
      </div>
    </div>
  )
}

function formatTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '--:--'
  const totalSec = Math.floor(ms / 1000)
  const mm = Math.floor(totalSec / 60).toString().padStart(2, '0')
  const ss = (totalSec % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

// ---------- styles (inline; mirrors MenuOverlay's vocabulary) ----------

const overlayBase: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2000,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background:
    'radial-gradient(ellipse at center, rgba(8,10,14,0.0) 0%, rgba(8,10,14,0.45) 55%, rgba(8,10,14,0.78) 100%)',
  fontFamily: '"Finger Paint", "Iowan Old Style", Georgia, serif',
  color: '#f5ead3',
  userSelect: 'none',
}

const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  padding: '36px 56px',
  borderRadius: 18,
  background: 'rgba(20, 24, 32, 0.72)',
  border: '1px solid rgba(245, 234, 211, 0.08)',
  backdropFilter: 'blur(8px)',
  minWidth: 280,
}

const eyebrow: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  opacity: 0.6,
}

const planetText: React.CSSProperties = {
  fontSize: 'clamp(28px, 4vw, 40px)',
  fontWeight: 400,
  letterSpacing: '0.02em',
  margin: 0,
}

const timeText: React.CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontSize: 'clamp(36px, 5vw, 56px)',
  letterSpacing: '0.06em',
  marginBottom: 8,
  opacity: 0.92,
}

const primaryButton: React.CSSProperties = {
  appearance: 'none',
  background: 'rgba(245, 234, 211, 0.08)',
  border: '1px solid rgba(245, 234, 211, 0.45)',
  color: '#f5ead3',
  fontFamily: 'inherit',
  fontSize: 18,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  padding: '12px 38px',
  borderRadius: 999,
  cursor: 'pointer',
  marginTop: 4,
  transition: 'background 180ms ease, border-color 180ms ease',
}
