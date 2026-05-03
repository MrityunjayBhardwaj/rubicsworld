import { useEffect, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { usePlanet } from './store'
import { isWalkBlocked } from './walkMask'
import { sphereDirToFlat } from './walkMask'
import { isPointBlocked, updateDynamicColliders } from './colliderRefs'
import { grassRefs } from '../diorama/buildGrass'
import { audioBus } from './audio/bus'
import { getPlayerHeight } from '../settings/levelSettings'

/**
 * First-person surface walk on the planet.
 *
 * Camera invariants while mounted:
 *   • position rides the actual ground surface — a per-frame raycast from
 *     PLANET_R outward toward the planet centre lands on the diorama
 *     terrain mesh; we then place the camera at hit + getPlayerHeight() along the
 *     local up. Falls back to the smooth sphere when the ray misses.
 *   • up = normalize(position) — gravity points to planet centre, so "up"
 *     for the camera is the surface normal at our current spot.
 *   • forward is maintained explicitly (not derived from rotation) and
 *     projected onto the tangent plane each frame; drift-corrected so it
 *     doesn't slide into the normal direction.
 *
 * Input:
 *   • Mouse move (no pointer-lock — Leva is hidden in walk mode anyway)
 *     → yaw around normal, pitch around local right. Pitch clamped so
 *     forward never collapses onto up.
 *   • W/A/S/D → translate along forward / right / -forward / -right in
 *     the tangent plane. Walk-mask gates the move; rejected steps slide
 *     along the dominant axis instead of full-stop.
 *   • Space → jump (impulse along radial up; gravity pulls toward centre).
 *   • Tab / Esc → exit walk mode.
 *
 * Entry transition: position + look direction lerp from the camera's
 *   orbit-mode pose to the surface spawn over EASE_DUR seconds. Mouse-look
 *   is ignored during the ease so the cinematic isn't fought.
 */

const PLANET_R = 1.0
// Eye-line altitude is now per-level — sourced from settings.walk.playerHeight
// via getPlayerHeight() (defaults.json + per-level sparse override). Read at
// each call site so a level switch / Leva edit takes effect on the next frame
// without re-mounting WalkControls. Reference value here is the global
// default; consumers should NEVER capture it once at module load.
const PLAYER_R = 0.03   // capsule radius — Minkowski-inflates each AABB
const WALK_SPEED = 0.3
const MOUSE_YAW   = 0.0025
const MOUSE_PITCH = 0.0025
const PITCH_MAX = Math.PI * 0.48
const JUMP_SPEED = 0.6              // initial radial velocity on Space
const FOOTSTEP_DIST = 0.5           // metres of walk per footstep tick
const GRAVITY    = 1.6              // pulled toward planet centre (units/s²)
const EASE_DUR   = 0.7              // seconds for the orbit→walk fly-in

export function WalkControls() {
  const { camera, scene } = useThree()
  const cameraMode = usePlanet(s => s.cameraMode)
  const setCameraMode = usePlanet(s => s.setCameraMode)

  const posRef = useRef<THREE.Vector3>(new THREE.Vector3(0, PLANET_R + getPlayerHeight(), 0))
  const fwdRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, -1))
  const pitchRef = useRef<number>(0)
  const keysRef = useRef<Set<string>>(new Set())
  // Vertical state: signed offset above the ground in the radial direction
  // (0 = on the surface, +ve = airborne). vertVel is the radial velocity.
  const vertOffsetRef = useRef<number>(0)
  const vertVelRef = useRef<number>(0)
  const distAccumRef = useRef<number>(0)
  // Eased entry: lerp camera pose orbit→walk so the transition reads as
  // a fly-in rather than a snap. Active while progress < 1.
  const easeRef = useRef<{ progress: number; from: THREE.Vector3; fromTarget: THREE.Vector3 } | null>(null)

  useEffect(() => {
    if (cameraMode !== 'walk') return

    const camPos = camera.position.clone()
    const normal = camPos.clone().normalize()
    posRef.current.copy(normal).multiplyScalar(PLANET_R + getPlayerHeight())
    const camFwd = new THREE.Vector3()
    camera.getWorldDirection(camFwd)
    camFwd.addScaledVector(normal, -camFwd.dot(normal))
    if (camFwd.lengthSq() < 1e-4) {
      camFwd.set(1, 0, 0).addScaledVector(normal, -normal.x).normalize()
    } else {
      camFwd.normalize()
    }
    fwdRef.current.copy(camFwd)
    pitchRef.current = 0
    keysRef.current.clear()
    vertOffsetRef.current = 0
    vertVelRef.current = 0

    // Capture orbit-mode pose so useFrame can ease toward the walk spawn.
    const lookTarget = new THREE.Vector3()
    camera.getWorldDirection(lookTarget)
    lookTarget.multiplyScalar(2).add(camPos)
    easeRef.current = {
      progress: 0,
      from: camPos.clone(),
      fromTarget: lookTarget,
    }

    // Pointer-lock for infinite look. Without it, `movementX/Y` cap out
    // when the cursor hits the window edge (you can't programmatically
    // warp the cursor in a browser — pointer-lock is the ONLY way to get
    // unbounded mouse deltas). Leva is hidden in walk mode (App.tsx wires
    // <Leva hidden={cameraMode === 'walk'} />), so the cursor has nothing
    // useful to interact with anyway. Esc releases the lock and exits.
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    // Try immediate lock from the keypress gesture chain that toggled walk
    // mode. If the browser rejects (no recent gesture), the canvas click
    // handler below catches the next user click as a fallback gesture.
    try { canvas?.requestPointerLock?.() } catch { /* ignore */ }
    const onCanvasClick = () => {
      if (!document.pointerLockElement) {
        try { canvas?.requestPointerLock?.() } catch { /* ignore */ }
      }
    }
    const onPointerLockChange = () => {
      // Fires for both lock acquisition AND release. On release (Esc, or
      // app blur), drop back to orbit mode — keeps the lock state and
      // walk state in lockstep.
      if (!document.pointerLockElement) {
        setCameraMode('orbit')
      }
    }
    canvas?.addEventListener('click', onCanvasClick)
    document.addEventListener('pointerlockchange', onPointerLockChange)

    const onMouseMove = (e: MouseEvent) => {
      if (easeRef.current && easeRef.current.progress < 1) return
      // When pointer-locked, mousemove fires on the locked element with
      // unbounded movementX/Y — no need to gate by target. When NOT locked
      // (lock failed / not yet engaged), keep the canvas-target gate so
      // hovering over any future HUD panel doesn't spin the view.
      if (!document.pointerLockElement) {
        const tgt = e.target as HTMLElement | null
        if (!(tgt instanceof HTMLCanvasElement)) return
      }
      const up = posRef.current.clone().normalize()
      fwdRef.current.applyAxisAngle(up, -e.movementX * MOUSE_YAW)
      fwdRef.current.addScaledVector(up, -fwdRef.current.dot(up))
      if (fwdRef.current.lengthSq() > 1e-8) fwdRef.current.normalize()
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
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        // Only jump when grounded. Prevents mid-air double-jumps; gravity
        // brings vertOffset back to zero on landing.
        if (vertOffsetRef.current <= 1e-4 && vertVelRef.current <= 1e-4) {
          vertVelRef.current = JUMP_SPEED
          audioBus.play('jump')
        }
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
      canvas?.removeEventListener('click', onCanvasClick)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      // Release the lock if we still hold it (e.g. user pressed Tab to
      // exit, the browser still has the lock). Guard so the
      // pointerlockchange handler — already detached — doesn't re-fire
      // setCameraMode in a loop.
      if (document.pointerLockElement) {
        try { document.exitPointerLock?.() } catch { /* ignore */ }
      }
      keysRef.current.clear()
      easeRef.current = null
      const exitDir = posRef.current.clone().normalize()
      camera.position.copy(exitDir).multiplyScalar(4.0)
      camera.up.set(0, 1, 0)
      camera.lookAt(0, 0, 0)
    }
  }, [cameraMode, camera, setCameraMode])

  // Reusable raycaster for the height-follow probe.
  const heightRayRef = useRef(new THREE.Raycaster())

  // Cast from a point above the surface along -up; first hit's distance from
  // origin gives the local terrain radius. Falls back to PLANET_R when no hit
  // (off-net) so the camera stays sane.
  function sampleTerrainRadiusAlong(up: THREE.Vector3): number {
    const PROBE = 1.0
    const origin = up.clone().multiplyScalar(PLANET_R + PROBE)
    const dir = up.clone().multiplyScalar(-1)
    const ray = heightRayRef.current
    ray.set(origin, dir)
    ray.far = PROBE + 0.5
    const hits = ray.intersectObjects(scene.children, true)
    if (hits.length === 0) return PLANET_R
    return (PLANET_R + PROBE) - hits[0].distance
  }

  useFrame((_, dt) => {
    if (cameraMode !== 'walk') return

    // Eased entry: blend from captured orbit pose to walk spawn pose.
    const ease = easeRef.current
    if (ease && ease.progress < 1) {
      ease.progress = Math.min(1, ease.progress + dt / EASE_DUR)
      const t = ease.progress * ease.progress * (3 - 2 * ease.progress)  // smoothstep

      const up = posRef.current.clone().normalize()
      const groundR = sampleTerrainRadiusAlong(up)
      const targetPos = up.clone().multiplyScalar(groundR + getPlayerHeight())
      const targetLook = targetPos.clone().add(fwdRef.current)

      const blendedPos = ease.from.clone().lerp(targetPos, t)
      const blendedLook = ease.fromTarget.clone().lerp(targetLook, t)

      camera.position.copy(blendedPos)
      camera.up.copy(up)
      camera.lookAt(blendedLook)

      if (ease.progress >= 1) easeRef.current = null
      return
    }

    const up = posRef.current.clone().normalize()
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
      // Refresh dynamic colliders once per query batch — cars / NPCs may
      // have moved this frame. Static boxes were baked at glb load.
      updateDynamicColliders()
      // Two-tier gate:
      //   1. walk-mask (cheap, painted, ground-level no-go)
      //   2. AABB collider list (3D boxes from Blender's rubics_collider
      //      collection — handles bridges, walls, moving objects)
      // Both tested in the same scene-graph world space. tryStep returns
      // false on either failure → axis-slide fallback to keep diagonal
      // movement smooth past walls.
      const tryStep = (delta: THREE.Vector3): boolean => {
        const probeWorld = posRef.current.clone().add(delta)
        const probeDir = probeWorld.clone().normalize()
        // 1. PNG walk-mask (legacy)
        if (isWalkBlocked(probeDir)) return false
        // 2. AABB colliders (Blender rubics_collider collection)
        if (isPointBlocked(probeWorld, PLAYER_R)) return false
        // 3. Vertex-color "colliders" layer (COLOR_2) on the terrain mesh.
        //    Painted in Blender's Vertex Paint mode on the third layer.
        //    R < 0.5 ⇒ blocked. Returns null when the probe falls outside
        //    any ground triangle — treat that as "no terrain coverage,
        //    don't add a verdict here" (other gates already ran).
        if (grassRefs.sampleColliderAt) {
          const flat = sphereDirToFlat(probeDir)
          const m = grassRefs.sampleColliderAt(flat.x, flat.z)
          if (m !== null && m < 0.5) return false
        }
        return true
      }
      let stepLen = 0
      if (tryStep(move)) {
        posRef.current.add(move)
        stepLen = move.length()
      } else {
        const fwdComp = fwdRef.current.clone().multiplyScalar(move.dot(fwdRef.current))
        const rgtComp = right.clone().multiplyScalar(move.dot(right))
        if (fwdComp.lengthSq() > 1e-10 && tryStep(fwdComp)) {
          posRef.current.add(fwdComp); stepLen = fwdComp.length()
        } else if (rgtComp.lengthSq() > 1e-10 && tryStep(rgtComp)) {
          posRef.current.add(rgtComp); stepLen = rgtComp.length()
        }
      }
      // Footstep tick — only when grounded; airborne walking shouldn't blip.
      if (stepLen > 0 && vertOffsetRef.current < 1e-3) {
        distAccumRef.current += stepLen
        if (distAccumRef.current >= FOOTSTEP_DIST) {
          audioBus.play('footstep')
          distAccumRef.current = 0
        }
      }
    }

    const upNow = posRef.current.clone().normalize()

    // Height-follow + jump integration. Vertical offset rides terrain;
    // jump impulse adds radial velocity; gravity decays toward the surface.
    const groundR = sampleTerrainRadiusAlong(upNow)
    vertVelRef.current -= GRAVITY * dt
    vertOffsetRef.current += vertVelRef.current * dt
    if (vertOffsetRef.current < 0) {
      vertOffsetRef.current = 0
      vertVelRef.current = 0
    }
    posRef.current.copy(upNow).multiplyScalar(groundR + getPlayerHeight() + vertOffsetRef.current)

    // Pitched look-direction: rotate tangent forward toward up by pitchRef.
    const cp = Math.cos(pitchRef.current)
    const sp = Math.sin(pitchRef.current)
    const lookDir = fwdRef.current.clone().multiplyScalar(cp).addScaledVector(upNow, sp)

    camera.position.copy(posRef.current)
    camera.up.copy(upNow)
    const target = posRef.current.clone().add(lookDir)
    camera.lookAt(target)
  })

  return null
}
