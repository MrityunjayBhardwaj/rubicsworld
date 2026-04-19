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
const PITCH_LIMIT = 0.97 // clamp |dot(forward, up)| so pitch stops short of vertical

export function WalkControls() {
  const { camera, gl } = useThree()
  const cameraMode = usePlanet(s => s.cameraMode)
  const setCameraMode = usePlanet(s => s.setCameraMode)

  // Persistent state across frames. Initialized on mount.
  const posRef = useRef<THREE.Vector3>(new THREE.Vector3(0, PLANET_R + PLAYER_H, 0))
  const fwdRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, -1))
  const keysRef = useRef<Set<string>>(new Set())
  // Tracks whether pointer-lock was ever actually granted — so onLockChange
  // can distinguish "user released lock" from "lock was never granted".
  const hadLockRef = useRef(false)

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

    // Request pointer lock — improves mouse-look by uncapping the cursor
    // from screen bounds. Browsers only grant this from a user gesture, so
    // this may silently fail in headless or if the entry trigger wasn't a
    // click. Walk mode still works without lock; mouse-delta is smaller
    // since the cursor hits screen edges. Don't bail on failure.
    const canvas = gl.domElement
    const requestLock = async () => {
      try { await canvas.requestPointerLock() } catch { /* ignore */ }
    }
    void requestLock()

    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return
      const up = posRef.current.clone().normalize()
      // Yaw: rotate forward around the up axis (negative movementX feels natural).
      fwdRef.current.applyAxisAngle(up, -e.movementX * MOUSE_YAW)
      // Pitch: rotate forward around local right axis.
      const right = new THREE.Vector3().crossVectors(fwdRef.current, up)
      if (right.lengthSq() > 1e-8) {
        right.normalize()
        fwdRef.current.applyAxisAngle(right, -e.movementY * MOUSE_PITCH)
      }
      // Clamp pitch so forward doesn't collide with up.
      const dotUp = fwdRef.current.dot(up)
      if (Math.abs(dotUp) > PITCH_LIMIT) {
        // Remove the excess, re-normalize in the tangent plane, add back
        // up-component at the limit.
        const sign = dotUp > 0 ? 1 : -1
        const tangent = fwdRef.current.clone().addScaledVector(up, -dotUp)
        if (tangent.lengthSq() > 1e-8) tangent.normalize()
        else tangent.copy(right) // safety fallback
        fwdRef.current.copy(tangent.multiplyScalar(Math.sqrt(1 - PITCH_LIMIT * PITCH_LIMIT)))
          .addScaledVector(up, sign * PITCH_LIMIT)
      }
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

    const onLockChange = () => {
      // If the user pressed Esc to exit pointer lock, also exit walk mode.
      // Only fires when we HAD the lock and lost it — so this doesn't fire
      // when lock was never granted in the first place (headless / non-gesture).
      if (hadLockRef.current && document.pointerLockElement !== canvas && usePlanet.getState().cameraMode === 'walk') {
        setCameraMode('orbit')
      }
      hadLockRef.current = document.pointerLockElement === canvas
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    document.addEventListener('pointerlockchange', onLockChange)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('pointerlockchange', onLockChange)
      keysRef.current.clear()
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      // Restore a comfortable third-person orbit distance. OrbitControls
      // remounts on next frame and takes over from here; we want the camera
      // to end up pulled back from the surface along the last-looked direction
      // so the transition reads as "stepping back from where you were."
      const exitDir = posRef.current.clone().normalize()
      camera.position.copy(exitDir).multiplyScalar(4.0)
      camera.up.set(0, 1, 0)
      camera.lookAt(0, 0, 0)
    }
  }, [cameraMode, camera, gl, setCameraMode])

  useFrame((_, dt) => {
    if (cameraMode !== 'walk') return
    const up = posRef.current.clone().normalize()
    // Drift correction: project forward onto the tangent plane and
    // renormalize so it doesn't accumulate a radial component.
    fwdRef.current.addScaledVector(up, -fwdRef.current.dot(up))
    if (fwdRef.current.lengthSq() < 1e-8) {
      fwdRef.current.set(1, 0, 0).addScaledVector(up, -up.x)
    }
    fwdRef.current.normalize()

    const right = new THREE.Vector3().crossVectors(fwdRef.current, up).normalize()

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

    camera.position.copy(posRef.current)
    camera.up.copy(posRef.current).normalize()
    const target = posRef.current.clone().add(fwdRef.current)
    camera.lookAt(target)
  })

  return null
}
