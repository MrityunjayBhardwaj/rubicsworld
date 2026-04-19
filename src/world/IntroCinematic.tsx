import { useEffect } from 'react'
import { usePlanet } from './store'

/**
 * First-frame cinematic attract sequence.
 *
 *   ├── INTRO_HOLD_MS = 2800 ── solved planet slow-orbiting, HUD attract full-on
 *   │                           (lets the player see the intact world first)
 *   ├── scrambleAnimated(N) ── animated scramble plays ~380 ms/move × N moves
 *   ├── orbit-scrambled    ── camera keeps auto-orbiting the scrambled planet
 *   └── player hovers or interacts → endIntro() → autoRotate off, control yields
 *
 * End conditions (any wins):
 *   • onPlanet flips true (raycast hover from Interaction.tsx)
 *   • drag begins (begin drag can fire before onPlanet on a click-and-drag)
 *   • walk mode entered
 *   • player keyboards a rotation
 */

const INTRO_HOLD_MS = 2800
const INTRO_SCRAMBLE_MOVES = 18

export function IntroCinematic() {
  const scrambleAnimated = usePlanet(s => s.scrambleAnimated)
  const setIntroPhase = usePlanet(s => s.setIntroPhase)

  useEffect(() => {
    // If the intro has already been played (store marks it 'done' across HMR
    // or a state-preserving reload), don't replay.
    if (usePlanet.getState().introPhase === 'done') return

    let aborted = false

    const tHold = setTimeout(async () => {
      if (aborted) return
      if (usePlanet.getState().introPhase === 'done') return
      setIntroPhase('scrambling')
      if (usePlanet.getState().introPhase === 'done') return
      await scrambleAnimated(INTRO_SCRAMBLE_MOVES)
      if (aborted) return
      if (usePlanet.getState().introPhase !== 'done') {
        setIntroPhase('orbit-scrambled')
      }
    }, INTRO_HOLD_MS)

    // End the intro on first meaningful engagement.
    const endIfIntroActive = () => {
      const phase = usePlanet.getState().introPhase
      if (phase !== 'done') setIntroPhase('done')
    }

    // Subscribe directly to store slices via zustand's subscribe API — cheaper
    // than a React render loop for a one-shot transition.
    const unsubOnPlanet = usePlanet.subscribe((s, prev) => {
      if (s.onPlanet && !prev.onPlanet) endIfIntroActive()
      if (s.drag && !prev.drag) endIfIntroActive()
      if (s.cameraMode === 'walk' && prev.cameraMode !== 'walk') endIfIntroActive()
    })

    return () => {
      aborted = true
      clearTimeout(tHold)
      unsubOnPlanet()
    }
  }, [scrambleAnimated, setIntroPhase])

  return null
}
