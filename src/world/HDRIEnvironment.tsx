import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import { useHdri } from './hdriStore'

/**
 * HDRI-based image-based lighting. Wraps drei's <Environment> and exposes
 * blur / intensity / rotation / background-opacity as live store values.
 *
 * When a user uploads an HDR/EXR blob URL it replaces the preset. The loaded
 * texture is also published to the store so TileGrid can mirror it onto its
 * offscreen dScene (where the diorama objects live) — without that mirror,
 * MeshStandardMaterial in dScene would have no environment to sample from.
 */
export function HDRIEnvironment() {
  const { scene } = useThree()
  const url = useHdri(s => s.url)
  const preset = useHdri(s => s.preset)
  const blur = useHdri(s => s.blur)
  const intensity = useHdri(s => s.intensity)
  const rotation = useHdri(s => s.rotation)
  const backgroundOpacity = useHdri(s => s.backgroundOpacity)
  const setEnvTexture = useHdri(s => s.setEnvTexture)

  // Push live HDRI parameters onto the scene. three r155+ supports these
  // scene-level properties directly; doing it imperatively sidesteps drei's
  // Environment prop surface which varies by version.
  useEffect(() => {
    scene.backgroundBlurriness = blur
    scene.environmentIntensity = intensity
    scene.backgroundIntensity = backgroundOpacity
    if (!scene.backgroundRotation) scene.backgroundRotation = new THREE.Euler()
    if (!scene.environmentRotation) scene.environmentRotation = new THREE.Euler()
    scene.backgroundRotation.set(0, rotation, 0)
    scene.environmentRotation.set(0, rotation, 0)
  }, [scene, blur, intensity, rotation, backgroundOpacity])

  // Publish the currently-active environment texture to the store every
  // frame scene.environment might change. Using a short interval is cheap
  // and avoids hooking into drei internals.
  useEffect(() => {
    const tick = () => { setEnvTexture(scene.environment ?? null) }
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [scene, setEnvTexture])

  // Always set background={true} so drei assigns scene.background = env
  // texture. Visibility is controlled via scene.backgroundIntensity in the
  // effect above — 0 blends to black (matches the canvas clear colour), 1
  // shows the full HDRI. Changing the `background` prop dynamically doesn't
  // always reapply, whereas scene.backgroundIntensity is a live scalar.
  if (url) {
    return <Environment key={`file:${url}`} files={url} background />
  }
  return <Environment key={`preset:${preset}`} preset={preset} background />
}
