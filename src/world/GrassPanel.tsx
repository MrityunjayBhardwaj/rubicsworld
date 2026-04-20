/**
 * Leva panel for grass uniforms + visible-count scaling.
 *
 * Writes directly into the module-scoped grassUniforms exported by
 * buildGrass — no props plumbing, same pattern as fresnelUniform and the
 * sphere slice uniforms. Density is applied by scaling mesh.count against
 * the allocated maxCount, so the slider is free (no geometry rebuild).
 */
import { useControls, folder } from 'leva'
import { useEffect } from 'react'
import * as THREE from 'three'
import { grassRefs, grassUniforms } from '../diorama/buildGrass'

export function GrassPanel() {
  const controls = useControls({
    Grass: folder(
      {
        visible:       { value: true },
        density:       { value: 1.0, min: 0, max: 1, step: 0.01, label: 'density (×max)' },
        windStrength:  { value: grassUniforms.uWindStrength.value, min: 0, max: 4, step: 0.01 },
        windFreq:      { value: grassUniforms.uWindFreq.value,     min: 0, max: 6, step: 0.01 },
        bendAmount:    { value: grassUniforms.uBendAmount.value,   min: 0, max: 0.6, step: 0.005, label: 'bend' },
        windDirX:      { value: grassUniforms.uWindDir.value.x,    min: -1, max: 1, step: 0.01 },
        windDirZ:      { value: grassUniforms.uWindDir.value.y,    min: -1, max: 1, step: 0.01 },
        baseColor:     { value: '#' + grassUniforms.uBaseColor.value.getHexString(), label: 'base colour' },
        tipColor:      { value: '#' + grassUniforms.uTipColor.value.getHexString(),  label: 'tip colour' },
        hueJitter:     { value: grassUniforms.uHueJitter.value, min: 0, max: 0.5, step: 0.01, label: 'hue jitter' },
      },
      { collapsed: true },
    ),
  })

  useEffect(() => {
    grassUniforms.uWindStrength.value = controls.windStrength
    grassUniforms.uWindFreq.value     = controls.windFreq
    grassUniforms.uBendAmount.value   = controls.bendAmount
    // Wind direction is consumed in blade-local frame; don't normalise —
    // a zero vector lets the user freeze sway without changing amplitude.
    grassUniforms.uWindDir.value.set(controls.windDirX, controls.windDirZ)
    grassUniforms.uHueJitter.value    = controls.hueJitter
    grassUniforms.uBaseColor.value.set(new THREE.Color(controls.baseColor))
    grassUniforms.uTipColor.value.set(new THREE.Color(controls.tipColor))
  }, [
    controls.windStrength, controls.windFreq, controls.bendAmount,
    controls.windDirX, controls.windDirZ, controls.hueJitter,
    controls.baseColor, controls.tipColor,
  ])

  useEffect(() => {
    const m = grassRefs.mesh
    if (!m) return
    m.visible = controls.visible
    const visibleCount = Math.max(0, Math.floor(grassRefs.maxCount * controls.density))
    m.count = visibleCount
  }, [controls.visible, controls.density])

  return null
}
