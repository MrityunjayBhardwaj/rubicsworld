import { useEffect, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import {
  EffectComposer,
  Bloom,
  DepthOfField,
  N8AO,
  Noise,
  SMAA,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import { folder, useControls } from 'leva'
import { usePlanet } from './store'

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t)
}

const WARM_DURATION_MS = 2000

/**
 * Path-1 effect stack (pmndrs ecosystem only, zero new deps):
 *
 *   render → SMAA → N8AO → DoF → Bloom → Noise → Vignette → screen
 *
 * Every param is exposed via Leva under the 'PostFx' folder — individual
 * per-effect enable toggles (for A/B), live tuning on sliders. Bloom and
 * vignette expose both endpoints of their warmth ramp (scrambled → solved).
 * The renderer's toneMappingExposure is also controlled from here so the
 * ACES compression can be dialled against the HDRI in real time.
 *
 * Architecture notes (required for Path-2 readiness — see
 * project_postfx_strategy.md):
 *   • multisampling={0} on EffectComposer — SSGI later needs full MSAA control
 *   • ACES ToneMapping lives on the RENDERER (App.tsx Canvas gl prop), NOT
 *     in the effect chain, so passes read linear color
 *   • <Canvas antialias={false}> — SMAA in chain replaces MSAA edges
 *   • usePlanet.sceneGrade flag is plumbed but unused at Path 1. Path 2
 *     will gate realism-effects (SSGI / TRAA / motion blur) behind
 *     sceneGrade === 'photoreal'
 */
export function PostFx() {
  const solved = usePlanet(s => s.solved)
  const [warmth, setWarmth] = useState(solved ? 1 : 0)
  const fromRef = useRef(warmth)
  const { gl } = useThree()

  const {
    exposure,
    smaaEnabled,
    n8aoEnabled, n8aoRadius, n8aoIntensity, n8aoFalloff, n8aoQuality,
    dofEnabled, dofFocusDistance, dofFocalLength, dofBokehScale,
    bloomEnabled, bloomScrambled, bloomSolved, bloomThreshold, bloomSmoothing,
    noiseEnabled, noiseOpacity,
    vignetteEnabled, vignetteScrambled, vignetteSolved, vignetteOffset,
  } = useControls('PostFx', {
    exposure: { value: 1.35, min: 0.3, max: 3, step: 0.05, label: 'Exposure (ACES)' },
    SMAA: folder({
      smaaEnabled: { value: true, label: 'on' },
    }, { collapsed: true }),
    N8AO: folder({
      n8aoEnabled: { value: true, label: 'on' },
      n8aoRadius: { value: 0.15, min: 0.01, max: 2, step: 0.01, label: 'radius' },
      n8aoIntensity: { value: 1.4, min: 0, max: 8, step: 0.1, label: 'intensity' },
      n8aoFalloff: { value: 0.5, min: 0, max: 3, step: 0.05, label: 'falloff' },
      n8aoQuality: {
        value: 'medium',
        options: ['performance', 'low', 'medium', 'high', 'ultra'],
        label: 'quality',
      },
    }, { collapsed: true }),
    'Depth of Field': folder({
      dofEnabled: { value: true, label: 'on' },
      dofFocusDistance: { value: 0.018, min: 0, max: 0.2, step: 0.001, label: 'focus dist' },
      dofFocalLength: { value: 0.12, min: 0.01, max: 0.5, step: 0.01, label: 'focal len' },
      dofBokehScale: { value: 1.4, min: 0, max: 8, step: 0.1, label: 'bokeh' },
    }, { collapsed: true }),
    Bloom: folder({
      bloomEnabled: { value: true, label: 'on' },
      bloomScrambled: { value: 0.35, min: 0, max: 3, step: 0.05, label: 'intensity (unsolved)' },
      bloomSolved: { value: 0.95, min: 0, max: 3, step: 0.05, label: 'intensity (solved)' },
      bloomThreshold: { value: 0.55, min: 0, max: 1, step: 0.01, label: 'lum threshold' },
      bloomSmoothing: { value: 0.4, min: 0, max: 1, step: 0.01, label: 'lum smooth' },
    }, { collapsed: true }),
    Noise: folder({
      noiseEnabled: { value: true, label: 'on' },
      noiseOpacity: { value: 0.08, min: 0, max: 1, step: 0.01, label: 'opacity' },
    }, { collapsed: true }),
    Vignette: folder({
      vignetteEnabled: { value: true, label: 'on' },
      vignetteScrambled: { value: 0.45, min: 0, max: 1.5, step: 0.01, label: 'darkness (unsolved)' },
      vignetteSolved: { value: 0.62, min: 0, max: 1.5, step: 0.01, label: 'darkness (solved)' },
      vignetteOffset: { value: 0.3, min: 0, max: 1, step: 0.01, label: 'offset' },
    }, { collapsed: true }),
  }, { collapsed: true })

  // Live-tune the renderer's tone-mapping exposure. ACES compresses highlights,
  // so this is the knob to keep bright zones from feeling dim.
  useEffect(() => {
    gl.toneMappingExposure = exposure
  }, [gl, exposure])

  useEffect(() => {
    const start = performance.now()
    fromRef.current = warmth
    const to = solved ? 1 : 0
    let raf = 0
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / WARM_DURATION_MS)
      setWarmth(lerp(fromRef.current, to, smoothstep(t)))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // intentional: only re-trigger on solved flip; warmth read once at start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solved])

  const bloomIntensity = lerp(bloomScrambled, bloomSolved, warmth)
  const vignetteDarkness = lerp(vignetteScrambled, vignetteSolved, warmth)

  return (
    <EffectComposer multisampling={0}>
      {smaaEnabled ? <SMAA /> : <></>}
      {n8aoEnabled ? (
        <N8AO
          aoRadius={n8aoRadius}
          intensity={n8aoIntensity}
          distanceFalloff={n8aoFalloff}
          quality={n8aoQuality as 'performance' | 'low' | 'medium' | 'high' | 'ultra'}
        />
      ) : <></>}
      {dofEnabled ? (
        <DepthOfField
          focusDistance={dofFocusDistance}
          focalLength={dofFocalLength}
          bokehScale={dofBokehScale}
        />
      ) : <></>}
      {bloomEnabled ? (
        <Bloom
          intensity={bloomIntensity}
          luminanceThreshold={bloomThreshold}
          luminanceSmoothing={bloomSmoothing}
          mipmapBlur
        />
      ) : <></>}
      {noiseEnabled ? (
        <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={noiseOpacity} />
      ) : <></>}
      {vignetteEnabled ? (
        <Vignette darkness={vignetteDarkness} offset={vignetteOffset} eskil={false} />
      ) : <></>}
    </EffectComposer>
  )
}
