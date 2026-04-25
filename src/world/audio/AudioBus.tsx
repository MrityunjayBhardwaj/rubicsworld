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
  const { camera } = useThree()
  const prevCamDir = useRef(new THREE.Vector3())
  const orbitSpeedSmooth = useRef(0)

  useEffect(() => {
    audioBus.attachListener(camera)
    installAudioSubscriptions()
    // Wind-strength source: read directly from the grass shader's wind
    // uniform so audio tracks whatever the user dialled in Leva.
    audioBus.setWindStrengthSource(() => grassUniforms.uWindStrength.value)
    return () => {
      // Don't detach on unmount: StrictMode double-invokes mount/unmount in
      // dev, and ripping the listener off mid-session kills the AudioContext
      // for the rest of the app. Listener stays parented to camera until the
      // app reloads.
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
    audioBus.tick()
  })

  return null
}
