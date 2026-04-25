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
  const orbitSpeedSmooth = useRef(0)
  const flockAnchor = useRef<THREE.Object3D | null>(null)
  const flockScratch = useRef(new THREE.Vector3())
  const pondScratch = useRef(new THREE.Vector3())

  useEffect(() => {
    audioBus.attachListener(camera)
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
    // Virtual anchor for the boids flock: we update its world position to
    // the centroid of the 'birds' group's child meshes each frame. Lives
    // for the lifetime of the AudioBus mount.
    if (!flockAnchor.current) {
      const a = new THREE.Object3D()
      a.name = 'birds_flock_anchor'
      scene.add(a)
      flockAnchor.current = a
      audioBus.registerAnchor('birds_flock', a)
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
        const omega = Math.acos(cosA) / dt  // rad/s
        // Map ~0..1.5 rad/s → 0..1, then smooth to avoid jitter.
        const target = Math.min(1, omega / 1.5)
        orbitSpeedSmooth.current += (target - orbitSpeedSmooth.current) * Math.min(1, dt * 6)
      }
      prevCamDir.current.copy(now)
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

    // Update flock centroid each frame. TileGrid registers the live 'birds'
    // group as anchor 'birds_group' — pull it from the bus, average child
    // positions, and route through localToWorld (birds children live in
    // diorama-root space, which itself sits inside dScene; localToWorld
    // walks the parent chain regardless of which Scene the group is in).
    const birdsGroup = audioBus.getAnchor('birds_group')
    if (birdsGroup && flockAnchor.current && birdsGroup.children.length > 0) {
      const c = flockScratch.current.set(0, 0, 0)
      const kids = birdsGroup.children
      for (const child of kids) c.add(child.position)
      c.multiplyScalar(1 / kids.length)
      birdsGroup.localToWorld(c)
      flockAnchor.current.position.copy(c)
    }

    audioBus.tick(dt)
  })

  return null
}
