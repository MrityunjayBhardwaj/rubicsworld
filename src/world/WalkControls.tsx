import { useEffect, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { usePlanet } from './store'

/**
 * First-person surface walk on the planet.
 *
 * Camera invariants while mounted:
 *   • position = normalize(p) * (PLANET_R + PLAYER_H)  — always at head
 *     height above the surface along the local radial normal.
 *   • up = normalize(position) — gravity points to planet centre, so "up"
 *     for the camera is the surface normal at our current spot.
 *   • forward is maintained explicitly (not derived from rotation) and
 *     projected onto the tangent plane each frame; drift-corrected so it
 *     doesn't slide into the normal direction.
 *
 * Input:
 *   • Mouse move (pointer-locked) → yaw around normal, pitch around local
 *     right. Pitch clamped so forward never collapses onto up.
 *   • W/A/S/D → translate along forward / right / -forward / -right in
 *     the tangent plane. Snap back to sphere surface after each step.
 *   • Tab → exit walk mode.
 *   • Pointer-lock release (Esc) → also exits.
 */

const PLANET_R = 1.0
const PLAYER_H = 0.08   // small-world scale — matches pocket-planet vibe
const WALK_SPEED = 0.3  // world units per second (~20 s to walk the equator)
const MOUSE_YAW   = 0.0025
const MOUSE_PITCH = 0.0025
const PITCH_MAX = Math.PI * 0.48  // ~86° — stop short of vertical either way

export function WalkControls() {
  const { camera } = useThree()
  const cameraMode = usePlanet(s => s.cameraMode)
  const setCameraMode = usePlanet(s => s.setCameraMode)

  // Persistent state across frames. Initialized on mount.
  const posRef = useRef<THREE.Vector3>(new THREE.Vector3(0, PLANET_R + PLAYER_H, 0))
  // Tangent-plane forward — drives WASD walking. Always strictly perpendicular
  // to the local surface normal; drift-corrected each frame.
  const fwdRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, -1))
  // Look-direction pitch in radians (scalar, ±PITCH_MAX). Kept separate from
  // fwdRef so mouse-look up/down doesn't interfere with tangent walking:
  // drift-correcting fwdRef would otherwise wipe any pitch the user applied.
  const pitchRef = useRef<number>(0)
  const keysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (cameraMode !== 'walk') return

    // Entry: spawn the player at the camera's current direction projected
    // to the sphere surface. Feels continuous with wherever they were
    // orbiting from. Forward = tangent in the direction the camera was facing.
    const camPos = camera.position.clone()
    const normal = camPos.clone().normalize()
    posRef.current.copy(normal).multiplyScalar(PLANET_R + PLAYER_H)
    // Forward: take the camera's current -Z direction, project into the
    // tangent plane, normalize. Fallback to a stable cross if degenerate.
    const camFwd = new THREE.Vector3()
    camera.getWorldDirection(camFwd) // unit, looking from camera into scene
    camFwd.addScaledVector(normal, -camFwd.dot(normal))
    if (camFwd.lengthSq() < 1e-4) {
      // Camera was aimed straight at the planet centre — pick any tangent.
      camFwd.set(1, 0, 0).addScaledVector(normal, -normal.x).normalize()
    } else {
      camFwd.normalize()
    }
    fwdRef.current.copy(camFwd)
    pitchRef.current = 0  // reset look pitch on every entry
    keysRef.current.clear()  // drop any keys still held from orbit mode

    // No pointer-lock: keeps the cursor visible so HDRI / Leva / any other
    // HUD panel remains interactive while walking. Trade-off is that mouse
    // deltas cap out when the cursor hits the window edge — acceptable
    // because you can re-sweep and keep turning. FPS-purity loses to
    // letting the user tune HDRI live without exiting walk mode.

    const onMouseMove = (e: MouseEvent) => {
      // Only look when the cursor is over the 3D canvas. Any HUD panel
      // (Leva, HDRIPanel, BezierCurveEditor, TileLabelsLegend, tooltips,
      // etc.) sits above the canvas with position:fixed — those targets
      // should remain interactive without spinning the view.
      const tgt = e.target as HTMLElement | null
      if (!(tgt instanceof HTMLCanvasElement)) return
      const up = posRef.current.clone().normalize()
      // Yaw: rotate the tangent forward around the up axis and keep it
      // strictly in the tangent plane. Negative movementX feels natural.
      fwdRef.current.applyAxisAngle(up, -e.movementX * MOUSE_YAW)
      fwdRef.current.addScaledVector(up, -fwdRef.current.dot(up))
      if (fwdRef.current.lengthSq() > 1e-8) fwdRef.current.normalize()
      // Pitch: scalar accumulator, clamped. The pitched look-direction is
      // derived in useFrame from (fwd, up, pitch) — keeping it separate from
      // fwd means drift correction can flatten fwd without wiping pitch.
      pitchRef.current -= e.movementY * MOUSE_PITCH
      if (pitchRef.current >  PITCH_MAX) pitchRef.current =  PITCH_MAX
      if (pitchRef.current < -PITCH_MAX) pitchRef.current = -PITCH_MAX
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
      if (e.key === 'Tab' || e.key === 'Escape') {
        e.preventDefault()
        setCameraMode('orbit')
        return
      }
      keysRef.current.add(e.key.toLowerCase())
    }
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase())
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      keysRef.current.clear()
      // Restore a comfortable third-person orbit distance. OrbitControls
      // remounts on next frame and takes over from here; we want the camera
      // to end up pulled back from the surface along the last-looked direction
      // so the transition reads as "stepping back from where you were."
      const exitDir = posRef.current.clone().normalize()
      camera.position.copy(exitDir).multiplyScalar(4.0)
      camera.up.set(0, 1, 0)
      camera.lookAt(0, 0, 0)
    }
  }, [cameraMode, camera, setCameraMode])

  useFrame((_, dt) => {
    if (cameraMode !== 'walk') return
    const up = posRef.current.clone().normalize()
    // Drift correction on tangent forward. Only touches the tangent vector —
    // pitch is in its own scalar so it's not disturbed.
    fwdRef.current.addScaledVector(up, -fwdRef.current.dot(up))
    if (fwdRef.current.lengthSq() < 1e-8) {
      fwdRef.current.set(1, 0, 0).addScaledVector(up, -up.x)
    }
    fwdRef.current.normalize()

    const right = new THREE.Vector3().crossVectors(fwdRef.current, up).normalize()

    // WASD walks along the TANGENT forward (unpitched), so looking up doesn't
    // slow you down or push you off the surface. Look direction is pitched
    // only for the camera, not for motion.
    const keys = keysRef.current
    const move = new THREE.Vector3()
    if (keys.has('w')) move.add(fwdRef.current)
    if (keys.has('s')) move.addScaledVector(fwdRef.current, -1)
    if (keys.has('d')) move.add(right)
    if (keys.has('a')) move.addScaledVector(right, -1)
    if (move.lengthSq() > 1e-8) {
      move.normalize().multiplyScalar(WALK_SPEED * dt)
      posRef.current.add(move)
      // Snap back to surface at player head height.
      posRef.current.normalize().multiplyScalar(PLANET_R + PLAYER_H)
    }

    // Pitched look-direction: rotate tangent forward toward up by pitchRef.
    const cp = Math.cos(pitchRef.current)
    const sp = Math.sin(pitchRef.current)
    const lookDir = fwdRef.current.clone().multiplyScalar(cp).addScaledVector(up, sp)

    camera.position.copy(posRef.current)
    camera.up.copy(up)
    const target = posRef.current.clone().add(lookDir)
    camera.lookAt(target)
  })

  return null
}
