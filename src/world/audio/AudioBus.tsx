import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { audioBus } from './bus'
import { installAudioSubscriptions } from './subscriptions'
import { grassUniforms } from '../../diorama/buildGrass'
import { usePlanet } from '../store'

// Mounts inside the main Canvas. Attaches the singleton AudioListener to the
// active camera and ticks the bus per frame. Idempotent across StrictMode
// double-invokes (bus.attachListener guards on parent === camera).
export function AudioBus() {
  const { camera, scene } = useThree()
  const prevCamDir = useRef(new THREE.Vector3())
  const prevCamPos = useRef(new THREE.Vector3())
  const orbitSpeedSmooth = useRef(0)
  const flockAnchor = useRef<THREE.Object3D | null>(null)
  const flockScratch = useRef(new THREE.Vector3())
  const pondScratch = useRef(new THREE.Vector3())
  const carScratch = useRef(new THREE.Vector3())
  const carPrev = useRef(new THREE.Vector3())
  const carInited = useRef(false)
  const carSpeedSmooth = useRef(0)

  useEffect(() => {
    audioBus.attachListener(camera)
    audioBus.attachSphereScene(scene)
    installAudioSubscriptions()

    // First-gesture unlock — browsers auto-suspend the AudioContext until a
    // user gesture. Hook a one-shot listener so loops start playing
    // automatically on the first interaction.
    const unlock = () => {
      const ctx = audioBus.context()
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ })
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock, { once: false })
    window.addEventListener('keydown', unlock, { once: false })

    // Visibility gate: suspend the AudioContext when the tab is hidden so
    // background tabs don't drone wind. Resume on visible.
    const onVis = () => {
      const ctx = audioBus.context()
      if (!ctx) return
      if (document.hidden) ctx.suspend().catch(() => { /* ignore */ })
      else ctx.resume().catch(() => { /* ignore */ })
    }
    document.addEventListener('visibilitychange', onVis)

    // Wind-strength source: read directly from the grass shader's wind
    // uniform so audio tracks whatever the user dialled in Leva.
    audioBus.setWindStrengthSource(() => grassUniforms.uWindStrength.value)
    // Virtual SOURCE for the boids flock — a dScene-local Object3D parented
    // to the birds group. We write the centroid (in birds-group local) to
    // its `position` each frame; the bus then projects flat→sphere and
    // pushes the result to the matching tracker in main scene. Source is
    // created lazily once birds_group is registered.
    flockAnchor.current = null
    // Scene-origin anchor: a virtual Object3D parked at (0,0,0). Loops can
    // anchor here for "centre of the sphere" positional sources (ambient
    // wind for the world, etc) so distance-based falloff is keyed off the
    // sphere centre.
    if (!audioBus.getAnchor('scene_center')) {
      const c = new THREE.Object3D()
      c.name = 'scene_center'
      // Position is (0,0,0) by default — keep it there.
      scene.add(c)
      audioBus.registerAnchor('scene_center', c)
    }
    return () => {
      // Don't detach the listener on unmount: StrictMode double-invokes
      // mount/unmount in dev, and ripping the listener off mid-session
      // kills the AudioContext for the rest of the app. Listener stays
      // parented to camera until the app reloads. Per-mount listeners are
      // detached because a fresh mount adds fresh handlers.
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [camera])

  useFrame((_, dt) => {
    // Camera-orbit speed: angular velocity of camera around scene origin.
    // In walk mode we still tick (footstep/jump events bypass this) but
    // the wind-cutting layer should mute since the camera isn't orbiting.
    const cameraMode = usePlanet.getState().cameraMode
    if (cameraMode === 'orbit') {
      const now = camera.position.clone().normalize()
      if (prevCamDir.current.lengthSq() > 0 && dt > 1e-4) {
        const cosA = THREE.MathUtils.clamp(prevCamDir.current.dot(now), -1, 1)
        const omega = Math.acos(cosA) / dt  // rad/s around scene origin
        const target = Math.min(1, omega / 1.5)
        orbitSpeedSmooth.current += (target - orbitSpeedSmooth.current) * Math.min(1, dt * 6)
      }
      prevCamDir.current.copy(now)
      prevCamPos.current.copy(camera.position)
    } else if (cameraMode === 'walk') {
      // Walk mode: linear camera velocity (player movement). Map a brisk
      // walk (~0.4 m/s in this scene) to ~0.7 so the wind-cutting layer is
      // audible while moving without drowning out footsteps.
      if (prevCamPos.current.lengthSq() > 0 && dt > 1e-4) {
        const linVel = prevCamPos.current.distanceTo(camera.position) / dt
        const target = Math.min(1, linVel / 0.6)
        orbitSpeedSmooth.current += (target - orbitSpeedSmooth.current) * Math.min(1, dt * 6)
      }
      prevCamPos.current.copy(camera.position)
      prevCamDir.current.copy(camera.position).normalize()
    } else {
      orbitSpeedSmooth.current += (0 - orbitSpeedSmooth.current) * Math.min(1, dt * 4)
    }
    audioBus.setCameraOrbitSpeed(orbitSpeedSmooth.current)

    // Theme music walk-duck: 1.0 in orbit, 0.5 in walk so the theme
    // recedes when the player is "in" the diorama vs observing it.
    audioBus.setThemeWalkDuck(cameraMode === 'walk' ? 0.5 : 1.0)

    // Pond proximity for ambient_world cross-fade. Compute distance from
    // listener (camera) to the pond mesh in world space, normalise to
    // pond_water's audible band so the ambient wind reduction matches the
    // pond audio's apparent reach.
    const pond = audioBus.getAnchor('pond')
    if (pond) {
      const PROX_REF = 1.5  // matches registry pond_water.refDist
      const PROX_MAX = 10   // matches registry pond_water.maxDist
      pond.getWorldPosition(pondScratch.current)
      const d = pondScratch.current.distanceTo(camera.position)
      const proximity = Math.max(0, Math.min(1, (PROX_MAX - d) / (PROX_MAX - PROX_REF)))
      audioBus.setPondProximity(proximity)
    } else {
      audioBus.setPondProximity(0)
    }

    // Car speed metric — derived from frame-to-frame world position delta
    // of the 'car' anchor. Normalised to the diorama's CAR_SPEED constant
    // (~0.55 u/s); engine pitch + filter open up as it moves faster.
    const car = audioBus.getAnchor('car')
    if (car && dt > 1e-4) {
      car.getWorldPosition(carScratch.current)
      if (carInited.current) {
        const v = carScratch.current.distanceTo(carPrev.current) / dt
        const target = Math.min(1, v / 0.55)
        carSpeedSmooth.current += (target - carSpeedSmooth.current) * Math.min(1, dt * 8)
      }
      carPrev.current.copy(carScratch.current)
      carInited.current = true
      audioBus.setCarSpeed(carSpeedSmooth.current)
    } else {
      audioBus.setCarSpeed(0)
    }

    // Update flock centroid each frame. TileGrid registers the live 'birds'
    // group as anchor 'birds_group'. We keep a SOURCE Object3D parented to
    // birds_group whose local `position` is the centroid of its sibling
    // bird meshes — staying inside birds-group local space avoids walking
    // through diorama.root (which gets clobbered every frame by the per-tile
    // render loop). The bus's updateSphereTrackers projects flat→sphere and
    // pushes to the main-scene tracker.
    const birdsGroup = audioBus.getAnchor('birds_group')
    if (birdsGroup) {
      let src = flockAnchor.current
      if (!src || src.parent !== birdsGroup) {
        src = new THREE.Object3D()
        src.name = '__audio_origin_birds_flock'
        birdsGroup.add(src)
        flockAnchor.current = src
        audioBus.registerDioramaSource('birds_flock', src)
      }
      if (birdsGroup.children.length > 1) {
        // Average sibling positions (ignore the source itself) in birds-group
        // local space. Source's local position becomes the local centroid.
        const c = flockScratch.current.set(0, 0, 0)
        let n = 0
        for (const child of birdsGroup.children) {
          if (child === src) continue
          c.add(child.position)
          n++
        }
        if (n > 0) {
          c.multiplyScalar(1 / n)
          src.position.copy(c)
        }
      }
    }

    // Project all diorama sources flat→sphere into their main-scene trackers.
    // Must run BEFORE audioBus.tick so any modulator/observation that depends
    // on tracker world position sees the current frame's value.
    audioBus.updateSphereTrackers()

    audioBus.tick(dt)
  })

  return null
}
