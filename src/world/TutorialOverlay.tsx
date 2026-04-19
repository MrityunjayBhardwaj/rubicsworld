import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useLottie } from 'lottie-react'
import * as THREE from 'three'
import { usePlanet } from './store'
import { tileCentroid, tileInSlice, AXIS_VEC, type Move } from './rotation'
import type { Tile } from './tile'
import { bfsSolve } from './tutorialSolver'
import swipeAnim from './assets/swipe-hint.json'

const PLANET_R = 1.0

/**
 * Guided-tutorial overlay.
 *
 * Two concerns rendered from this file:
 *   • <TutorialHint/> — R3F-child. Anchors a Lottie swipe hint just above the
 *     target tile via drei <Html>. Updates tangent angle each frame so the
 *     swipe direction tracks the camera.
 *   • <TutorialChrome/> — pure DOM (mount outside Canvas). Skip link + step
 *     counter.
 *
 * Mount both while introPhase === 'tutorial'; both early-return otherwise.
 */

function pickDemoTile(tiles: readonly Tile[], move: Move, cameraPos: THREE.Vector3): Tile | null {
  let bestScore = -Infinity
  let bestTile: Tile | null = null
  const camDir = cameraPos.clone().normalize()
  for (const t of tiles) {
    if (!tileInSlice(t, move.axis, move.slice)) continue
    const c = tileCentroid(t.face, t.u, t.v).normalize()
    const score = c.dot(camDir) // max when tile faces camera
    if (score > bestScore) {
      bestScore = score
      bestTile = t
    }
  }
  return bestTile
}

export function TutorialHint() {
  const introPhase = usePlanet(s => s.introPhase)
  const queue = usePlanet(s => s.tutorialQueue)
  const step = usePlanet(s => s.tutorialStep)
  const tiles = usePlanet(s => s.tiles)
  const camera = useThree(s => s.camera)

  const groupRef = useRef<THREE.Group>(null!)
  const rotatorRef = useRef<HTMLDivElement | null>(null)
  const demoTileRef = useRef<Tile | null>(null)
  const sphereAnchor = useMemo(() => new THREE.Vector3(), [])

  const active = introPhase === 'tutorial' && queue[step] !== undefined

  // Re-pick demo tile when the step advances (or the queue is rebuilt by a
  // BFS re-solve). Using current tiles + camera position; held for the
  // duration of this step so the hint doesn't jitter between candidates.
  useEffect(() => {
    if (!active) {
      demoTileRef.current = null
      return
    }
    demoTileRef.current = pickDemoTile(tiles, queue[step], camera.position)
  }, [active, tiles, queue, step, camera])

  useFrame(() => {
    const g = groupRef.current
    if (!g) return
    const tile = demoTileRef.current
    const move = queue[step]
    if (!active || !tile || !move) {
      g.visible = false
      return
    }
    g.visible = true

    // Anchor floats slightly above the sphere surface so the Lottie doesn't
    // occlude the tile it's pointing at.
    const centroid = tileCentroid(tile.face, tile.u, tile.v).normalize()
    sphereAnchor.copy(centroid).multiplyScalar(PLANET_R * 1.28)
    g.position.copy(sphereAnchor)

    // Tangent direction of rotation at this point: cross(axisVec, spherePos)
    // oriented by dir. Projected into screen space to rotate the Lottie so
    // its left→right motion reads as the required swipe direction.
    const surfaceP = centroid.clone().multiplyScalar(PLANET_R)
    const tangent = new THREE.Vector3().crossVectors(AXIS_VEC[move.axis], surfaceP)
    if (tangent.lengthSq() < 1e-6) return
    tangent.normalize().multiplyScalar(move.dir)

    const pNdc = surfaceP.clone().project(camera)
    const qNdc = surfaceP.clone().addScaledVector(tangent, 0.15).project(camera)
    const dx = qNdc.x - pNdc.x
    const dy = qNdc.y - pNdc.y
    // NDC y is up; CSS rotate y-down. Negate dy for screen-space angle.
    const angleDeg = (Math.atan2(-dy, dx) * 180) / Math.PI

    if (rotatorRef.current) {
      rotatorRef.current.style.transform = `rotate(${angleDeg.toFixed(1)}deg)`
    }
  })

  // useLottie returns a prepared View element — sidesteps the
  // default-export interop quirks that break `<Lottie>` under Vite + React 19.
  const { View: LottieView } = useLottie({
    animationData: swipeAnim,
    loop: true,
    autoplay: true,
    style: { width: '100%', height: '100%' },
  })

  if (!active) return null

  return (
    <group ref={groupRef}>
      <Html
        center
        zIndexRange={[100, 0]}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        <div
          ref={rotatorRef}
          style={{
            width: 160,
            height: 80,
            transformOrigin: '50% 50%',
            filter: 'drop-shadow(0 0 8px rgba(255,220,120,0.6))',
          }}
        >
          {LottieView}
        </div>
      </Html>
    </group>
  )
}

function skipTutorial() {
  try { localStorage.setItem('rubicsworld:tutorialSeen', '1') } catch { /* ignore */ }
  usePlanet.getState().setIntroPhase('done')
}

export function TutorialChrome() {
  const introPhase = usePlanet(s => s.introPhase)
  const step = usePlanet(s => s.tutorialStep)
  const total = usePlanet(s => s.tutorialQueue.length)
  const active = introPhase === 'tutorial'

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skipTutorial()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  // Progress tracker: watch history growth. Compare the latest committed
  // move to tutorialQueue[tutorialStep]. On match, advance the step. On the
  // final match the puzzle will have just landed at solved — write the flag
  // and transition to 'done'. Mismatch handling (BFS re-solve) is Phase 5;
  // for now a wrong move leaves the queue intact and the hint keeps pointing
  // at the same next expected move.
  useEffect(() => {
    if (!active) return
    const unsub = usePlanet.subscribe((s, prev) => {
      if (s.introPhase !== 'tutorial') return
      if (s.history.length <= prev.history.length) return

      const latest = s.history[s.history.length - 1]
      const expected = s.tutorialQueue[s.tutorialStep]
      if (!expected) return

      const matches =
        latest.axis === expected.axis &&
        latest.slice === expected.slice &&
        latest.dir === expected.dir

      if (matches) {
        const nextStep = s.tutorialStep + 1
        if (nextStep >= s.tutorialQueue.length) {
          // Final expected move committed — puzzle should now be solved.
          // applyRotation fires planet:settled inside the same reducer
          // update, so the warmth/bloom ramp is already ticking.
          try { localStorage.setItem('rubicsworld:tutorialSeen', '1') } catch { /* ignore */ }
          s.setIntroPhase('done')
        } else {
          s.setTutorialStep(nextStep)
        }
        return
      }

      // Wrong move — re-solve from the current state with BFS so the hint
      // re-points at the new shortest path. If the user has scrambled past
      // our tutorial depth, gracefully skip.
      const solution = bfsSolve(s.tiles, 5)
      if (solution === null) {
        try { localStorage.setItem('rubicsworld:tutorialSeen', '1') } catch { /* ignore */ }
        s.setIntroPhase('done')
        return
      }
      if (solution.length === 0) {
        // Somehow already solved after the wrong move — finish.
        try { localStorage.setItem('rubicsworld:tutorialSeen', '1') } catch { /* ignore */ }
        s.setIntroPhase('done')
        return
      }
      s.setTutorialQueue(solution) // resets step to 0
    })
    return unsub
  }, [active])

  if (!active) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 28,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        pointerEvents: 'none',
        zIndex: 20,
        fontFamily: 'system-ui, sans-serif',
        color: 'rgba(255, 238, 190, 0.92)',
      }}
    >
      <div style={{ fontSize: 13, letterSpacing: 0.5, opacity: 0.85 }}>
        Swipe the glowing tile to rotate its slice — {step + 1} of {total}
      </div>
      <button
        onClick={skipTutorial}
        style={{
          pointerEvents: 'auto',
          background: 'transparent',
          border: '1px solid rgba(255,238,190,0.35)',
          borderRadius: 14,
          color: 'rgba(255,238,190,0.75)',
          fontSize: 11,
          padding: '4px 12px',
          cursor: 'pointer',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        }}
      >
        Skip tutorial
      </button>
    </div>
  )
}
