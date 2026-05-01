import { useEffect, useState } from 'react'
import { usePlanet } from './store'

/**
 * Title screen + in-game pause menu.
 *
 * Two visual modes driven by store:
 *   gamePhase === 'title'                 → title screen ("Rubic's World" + Begin)
 *   gamePhase === 'playing' && menuOpen   → pause overlay (Resume / Audio / Return)
 *
 * Esc handling lives here as a global keydown (capture phase) so it works
 * regardless of which canvas/element has focus. WalkControls' Tab handler
 * stays separate (Tab → orbit, no menu open). When the browser releases
 * pointer-lock on Esc inside walk mode, WalkControls' pointerlockchange
 * handler drops to orbit; the next Esc opens the menu via this listener.
 *
 * Title screen uses the existing planet+ring as backdrop (the auto-orbit
 * attract continues running because IntroCinematic is gated to 'playing'
 * but `introPhase: 'orbit-solved'` keeps autoRotate on in App.tsx).
 */
export function MenuOverlay() {
  const gamePhase = usePlanet(s => s.gamePhase)
  const menuOpen = usePlanet(s => s.menuOpen)
  const audioMuted = usePlanet(s => s.audioMuted)
  const setGamePhase = usePlanet(s => s.setGamePhase)
  const toggleMenu = usePlanet(s => s.toggleMenu)
  const setMenuOpen = usePlanet(s => s.setMenuOpen)
  const setAudioMuted = usePlanet(s => s.setAudioMuted)
  const resetProgress = usePlanet(s => s.resetProgress)
  const returnToTitle = usePlanet(s => s.returnToTitle)

  // Title fade-in on first paint (~1.2s) so the planet+ring read first.
  const [titleFaded, setTitleFaded] = useState(false)
  useEffect(() => {
    if (gamePhase !== 'title') return
    const id = requestAnimationFrame(() => setTitleFaded(true))
    return () => cancelAnimationFrame(id)
  }, [gamePhase])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Title screen: Esc is no-op (Begin is the only forward action).
      if (usePlanet.getState().gamePhase !== 'playing') return
      e.preventDefault()
      toggleMenu()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleMenu])

  if (gamePhase === 'title') {
    return (
      <TitleView
        faded={titleFaded}
        audioMuted={audioMuted}
        onBegin={() => setGamePhase('playing')}
        onToggleAudio={() => setAudioMuted(!audioMuted)}
        onReset={resetProgress}
      />
    )
  }

  if (menuOpen) {
    return (
      <PauseView
        audioMuted={audioMuted}
        onResume={() => setMenuOpen(false)}
        onToggleAudio={() => setAudioMuted(!audioMuted)}
        onReturnToTitle={returnToTitle}
      />
    )
  }

  return null
}

interface TitleProps {
  faded: boolean
  audioMuted: boolean
  onBegin: () => void
  onToggleAudio: () => void
  onReset: () => void
}

function TitleView({ faded, audioMuted, onBegin, onToggleAudio, onReset }: TitleProps) {
  return (
    <div style={{ ...overlayBase, opacity: faded ? 1 : 0, transition: 'opacity 1200ms ease-out' }}>
      <div style={titleStack}>
        <h1 style={titleText}>Rubic&rsquo;s World</h1>
        <div style={taglineText}>Solve the world. Then be in it.</div>
        <button style={primaryButton} onClick={onBegin} autoFocus>Begin</button>
      </div>
      <div style={titleFootBar}>
        <button style={textLink} onClick={onToggleAudio}>
          audio: {audioMuted ? 'off' : 'on'}
        </button>
        <span style={textLinkSeparator}>·</span>
        <button style={textLink} onClick={onReset} title="Clears tutorial-seen flag and audio settings">
          reset progress
        </button>
      </div>
    </div>
  )
}

interface PauseProps {
  audioMuted: boolean
  onResume: () => void
  onToggleAudio: () => void
  onReturnToTitle: () => void
}

function PauseView({ audioMuted, onResume, onToggleAudio, onReturnToTitle }: PauseProps) {
  return (
    <div style={{ ...overlayBase, background: 'rgba(8, 10, 14, 0.55)' }}>
      <div style={pauseCard}>
        <div style={pauseHeader}>Paused</div>
        <button style={primaryButton} onClick={onResume} autoFocus>Resume</button>
        <button style={secondaryButton} onClick={onToggleAudio}>
          Audio: {audioMuted ? 'off' : 'on'}
        </button>
        <button style={secondaryButton} onClick={onReturnToTitle}>Return to title</button>
        <div style={pauseHint}>esc to resume</div>
      </div>
    </div>
  )
}

// ---------- styles (inline, scoped to this file) ----------

const overlayBase: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2000, // above Leva (1000), below any debug toasts
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background:
    'radial-gradient(ellipse at center, rgba(8,10,14,0.0) 0%, rgba(8,10,14,0.45) 55%, rgba(8,10,14,0.75) 100%)',
  fontFamily: '"Finger Paint", "Iowan Old Style", Georgia, serif',
  color: '#f5ead3',
  userSelect: 'none',
}

const titleStack: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 18,
  textAlign: 'center',
  padding: '0 24px',
}

const titleText: React.CSSProperties = {
  fontSize: 'clamp(48px, 8vw, 96px)',
  fontWeight: 400,
  letterSpacing: '0.02em',
  margin: 0,
  textShadow: '0 2px 24px rgba(0,0,0,0.5)',
  color: '#f5ead3',
}

const taglineText: React.CSSProperties = {
  // Finger Paint ships regular only — no italic file. Browser-synthesized
  // italic on a handwritten face slants every stroke and reads as a glitch,
  // so the tagline stays upright and leans on opacity + letter-spacing for
  // hierarchy instead.
  fontSize: 'clamp(14px, 1.3vw, 18px)',
  opacity: 0.78,
  letterSpacing: '0.04em',
  marginBottom: 12,
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
  transition: 'background 180ms ease, border-color 180ms ease, transform 180ms ease',
}

const secondaryButton: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: '1px solid rgba(245, 234, 211, 0.18)',
  color: '#f5ead3',
  fontFamily: 'inherit',
  fontSize: 14,
  letterSpacing: '0.12em',
  padding: '8px 22px',
  borderRadius: 999,
  cursor: 'pointer',
  opacity: 0.85,
  transition: 'opacity 160ms ease, border-color 160ms ease',
}

const titleFootBar: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: 0,
  right: 0,
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 12,
  fontSize: 12,
  letterSpacing: '0.08em',
  opacity: 0.55,
}

const textLink: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  color: '#f5ead3',
  fontFamily: 'inherit',
  fontSize: 12,
  letterSpacing: '0.08em',
  cursor: 'pointer',
  padding: '4px 8px',
  textTransform: 'lowercase',
}

const textLinkSeparator: React.CSSProperties = {
  opacity: 0.35,
}

const pauseCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 10,
  padding: '32px 44px',
  borderRadius: 18,
  background: 'rgba(20, 24, 32, 0.72)',
  border: '1px solid rgba(245, 234, 211, 0.08)',
  backdropFilter: 'blur(8px)',
  minWidth: 260,
}

const pauseHeader: React.CSSProperties = {
  fontSize: 22,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  opacity: 0.7,
  marginBottom: 10,
}

const pauseHint: React.CSSProperties = {
  marginTop: 8,
  fontSize: 11,
  letterSpacing: '0.18em',
  textTransform: 'lowercase',
  opacity: 0.4,
}
