import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import { useHdri } from './hdriStore'

/** Small solid-colour equirect canvas. Three's renderer auto-PMREMs this
 *  at bind-time when used as scene.environment (same path as drei presets,
 *  which hand us a 1024×512 equirect — not a pre-PMREM'd cube-uv map). */
function makeUniformEquirectTexture(hex: string): THREE.CanvasTexture {
  const W = 256, H = 128
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = hex
  ctx.fillRect(0, 0, W, H)
  const tex = new THREE.CanvasTexture(canvas)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

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
  const uniformColor = useHdri(s => s.uniformColor)
  const setEnvTexture = useHdri(s => s.setEnvTexture)
  const useUniform = !url && preset === 'uniform'

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
  // Uniform mode — build a tiny solid-colour equirect texture and assign it
  // directly. Bypasses drei <Environment> (which expects a real HDR/preset).
  // Memoised per hex so the colour picker doesn't churn GPU uploads.
  const uniformTex = useMemo(
    () => (useUniform ? makeUniformEquirectTexture(uniformColor) : null),
    [useUniform, uniformColor],
  )
  useEffect(() => {
    if (!uniformTex) return
    const prevEnv = scene.environment
    const prevBg = scene.background
    scene.environment = uniformTex
    scene.background = uniformTex
    return () => {
      if (scene.environment === uniformTex) scene.environment = prevEnv
      if (scene.background === uniformTex) scene.background = prevBg
      uniformTex.dispose()
    }
  }, [scene, uniformTex])

  if (useUniform) return null
  if (url) {
    return <Environment key={`file:${url}`} files={url} background />
  }
  // `useUniform` guard above narrows preset out of 'uniform', but TS can't
  // infer through the Zustand selector — explicit cast.
  const dreiPreset = preset as Exclude<typeof preset, 'uniform'>
  return <Environment key={`preset:${dreiPreset}`} preset={dreiPreset} background />
}
