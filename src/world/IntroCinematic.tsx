import { useEffect } from 'react'
import { usePlanet } from './store'
import { inverseMove, type Move } from './rotation'

/**
 * First-frame cinematic attract sequence.
 *
 * Branches on localStorage.rubicsworld:tutorialSeen:
 *   • First visit (flag not set) → onboarding tutorial: solved hold →
 *     deterministic 3-move scramble → 'tutorial' phase (TutorialOverlay
 *     guides the user to solve). Flag written on solve or skip.
 *   • Repeat visit (flag set) → original attract: solved hold →
 *     18-move random scramble → 'orbit-scrambled' → yield on first input.
 *
 * End conditions by path:
 *   Tutorial: introPhase === 'done' via solve OR skip (walk / Esc / skip link)
 *   Attract:  onPlanet, drag, walk, or keyboard rotation (first meaningful input)
 */

const INTRO_HOLD_MS = 2800
const ATTRACT_SCRAMBLE_MOVES = 18
const TUTORIAL_SEEN_KEY = 'rubicsworld:tutorialSeen'

// Deterministic 3-move scramble — curated to touch three different axes and
// mix directions. Played at tutorial start; the overlay then guides the
// inverse sequence back to solved.
const TUTORIAL_SCRAMBLE: Move[] = [
  { axis: 'y', slice: 1, dir: 1 },
  { axis: 'x', slice: 0, dir: -1 },
  { axis: 'z', slice: 1, dir: 1 },
]

function hasSeenTutorial(): boolean {
  try {
    return typeof localStorage !== 'undefined' &&
      localStorage.getItem(TUTORIAL_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function IntroCinematic() {
  const rotateAnimated = usePlanet(s => s.rotateAnimated)
  const scrambleAnimated = usePlanet(s => s.scrambleAnimated)
  const setIntroPhase = usePlanet(s => s.setIntroPhase)
  const setTutorialQueue = usePlanet(s => s.setTutorialQueue)

  useEffect(() => {
    // Idempotent skip — if a prior mount already finished the sequence,
    // don't replay. Also guards Strict Mode double-invoke: the first mount
    // advances phase past 'orbit-solved' on a timer; the second mount sees
    // the advanced state and early-returns. See hetvabhasa P3.
    if (usePlanet.getState().introPhase === 'done') return

    const skipTutorial = hasSeenTutorial()
    let aborted = false

    const tHold = setTimeout(async () => {
      if (aborted) return
      if (usePlanet.getState().introPhase === 'done') return
      setIntroPhase('scrambling')

      if (skipTutorial) {
        // Original attract path.
        if (usePlanet.getState().introPhase === 'done') return
        await scrambleAnimated(ATTRACT_SCRAMBLE_MOVES)
        if (aborted) return
        if (usePlanet.getState().introPhase !== 'done') {
          setIntroPhase('orbit-scrambled')
        }
        return
      }

      // Tutorial path — deterministic 3-move scramble.
      for (const m of TUTORIAL_SCRAMBLE) {
        if (aborted) return
        if (usePlanet.getState().introPhase === 'done') return
        await rotateAnimated(m)
      }
      if (aborted) return
      if (usePlanet.getState().introPhase === 'done') return

      // Solution queue = scramble reversed + each move inverted.
      const queue = TUTORIAL_SCRAMBLE.slice().reverse().map(inverseMove)
      setTutorialQueue(queue)
      setIntroPhase('tutorial')
    }, INTRO_HOLD_MS)

    // End-intro triggers differ per path:
    //   Attract path: first meaningful input ends the intro.
    //   Tutorial path: hover/drag/key are EXPECTED inputs — they progress
    //     the tutorial, not end it. Only walk-mode entry short-circuits.
    const unsub = usePlanet.subscribe((s, prev) => {
      const phase = s.introPhase
      if (phase === 'done') return

      if (skipTutorial) {
        if (s.onPlanet && !prev.onPlanet) setIntroPhase('done')
        if (s.drag && !prev.drag) setIntroPhase('done')
        if (s.cameraMode === 'walk' && prev.cameraMode !== 'walk') setIntroPhase('done')
      } else {
        // Walk mode during tutorial counts as a skip.
        if (s.cameraMode === 'walk' && prev.cameraMode !== 'walk') {
          try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1') } catch { /* ignore */ }
          setIntroPhase('done')
        }
      }
    })

    return () => {
      aborted = true
      clearTimeout(tHold)
      unsub()
    }
  }, [rotateAnimated, scrambleAnimated, setIntroPhase, setTutorialQueue])

  return null
}
