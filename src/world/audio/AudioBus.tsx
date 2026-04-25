import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { audioBus } from './bus'
import { installAudioSubscriptions } from './subscriptions'

// Mounts inside the main Canvas. Attaches the singleton AudioListener to the
// active camera and ticks the bus per frame. Idempotent across StrictMode
// double-invokes (bus.attachListener guards on parent === camera).
export function AudioBus() {
  const { camera } = useThree()

  useEffect(() => {
    audioBus.attachListener(camera)
    installAudioSubscriptions()
    return () => {
      // Don't detach on unmount: StrictMode double-invokes mount/unmount in
      // dev, and ripping the listener off mid-session kills the AudioContext
      // for the rest of the app. Listener stays parented to camera until the
      // app reloads.
    }
  }, [camera])

  useFrame(() => {
    audioBus.tick()
  })

  return null
}
