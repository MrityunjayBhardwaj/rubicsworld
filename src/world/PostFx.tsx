import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { DepthOfFieldEffect } from 'postprocessing'
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
import { RealismFX } from './RealismFX'
import { hudUniforms } from '../diorama/buildDiorama'

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
    dofEnabled, dofFollowCursor, dofFocalLength, dofBokehScale, dofSmoothing,
    bloomEnabled, bloomScrambled, bloomSolved, bloomThreshold, bloomSmoothing,
    noiseEnabled, noiseOpacity,
    vignetteEnabled, vignetteScrambled, vignetteSolved, vignetteOffset,
    ssgiEnabled, ssgiDistance, ssgiThickness, ssgiAutoThickness, ssgiMaxRoughness,
    ssgiBlend, ssgiImportanceSampling, ssgiDirectLightMultiplier, ssgiEnvBlur,
    ssgiSteps, ssgiRefineSteps, ssgiSpp, ssgiResolutionScale, ssgiMissedRays,
    ssgiDenoiseIterations, ssgiDenoiseKernel, ssgiDenoiseDiffuse, ssgiDenoiseSpecular,
    ssgiDepthPhi, ssgiNormalPhi, ssgiRoughnessPhi,
    ssrEnabled,
    motionBlurEnabled, motionBlurIntensity, motionBlurJitter, motionBlurSamples,
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
      dofFollowCursor: { value: true, label: 'follow cursor (else planet)' },
      dofFocalLength: { value: 0.12, min: 0.01, max: 0.5, step: 0.01, label: 'focal len' },
      dofBokehScale: { value: 1.4, min: 0, max: 8, step: 0.1, label: 'bokeh' },
      dofSmoothing: { value: 0.18, min: 0.01, max: 1, step: 0.01, label: 'follow speed' },
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
    // Path 2 — realism-effects (SSGI / SSR / motion blur). Default OFF
    // because the current stylized diorama has near-zero PBR surfaces; SSGI
    // on low-poly vertex-coloured meshes reads as noise. Flip to 'on' when
    // the photoreal Blender diorama is loaded.
    // Realism-effects (SSGI + SSR + motion blur). Defaults OFF — visual
    // impact is subtle on the stylized test diorama; SSR needs reflective
    // PBR materials to shine. Will earn its keep on the photoreal Blender
    // diorama. Param groupings mirror realism-effects' SSGIEffect constructor.
    SSGI: folder({
      ssgiEnabled: { value: false, label: 'on' },
      'SSGI — rays': folder({
        ssgiDistance: { value: 10, min: 0.1, max: 100, step: 0.5, label: 'ray distance' },
        ssgiThickness: { value: 10, min: 0.1, max: 100, step: 0.5, label: 'thickness' },
        ssgiAutoThickness: { value: false, label: 'auto thickness' },
        ssgiMaxRoughness: { value: 1, min: 0, max: 1, step: 0.01, label: 'max roughness' },
        ssgiSteps: { value: 20, min: 1, max: 128, step: 1, label: 'march steps' },
        ssgiRefineSteps: { value: 5, min: 0, max: 32, step: 1, label: 'refine steps' },
        ssgiSpp: { value: 1, min: 1, max: 8, step: 1, label: 'samples/pixel' },
        ssgiMissedRays: { value: false, label: 'sample missed (env)' },
      }, { collapsed: true }),
      'SSGI — temporal': folder({
        ssgiBlend: { value: 0.9, min: 0, max: 1, step: 0.01, label: 'temporal blend' },
        ssgiImportanceSampling: { value: true, label: 'importance sampling' },
        ssgiDirectLightMultiplier: { value: 1, min: 0, max: 8, step: 0.05, label: 'direct light ×' },
        ssgiEnvBlur: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'env blur' },
      }, { collapsed: true }),
      'SSGI — denoise': folder({
        ssgiDenoiseIterations: { value: 1, min: 0, max: 8, step: 1, label: 'iterations' },
        ssgiDenoiseKernel: { value: 2, min: 1, max: 6, step: 1, label: 'kernel' },
        ssgiDenoiseDiffuse: { value: 10, min: 0, max: 50, step: 0.5, label: 'diffuse weight' },
        ssgiDenoiseSpecular: { value: 10, min: 0, max: 50, step: 0.5, label: 'specular weight' },
        ssgiDepthPhi: { value: 2, min: 0, max: 50, step: 0.1, label: 'depth φ' },
        ssgiNormalPhi: { value: 50, min: 0, max: 100, step: 1, label: 'normal φ' },
        ssgiRoughnessPhi: { value: 1, min: 0, max: 10, step: 0.05, label: 'roughness φ' },
      }, { collapsed: true }),
      'SSGI — perf': folder({
        ssgiResolutionScale: { value: 1, min: 0.25, max: 1, step: 0.05, label: 'res scale' },
      }, { collapsed: true }),
    }, { collapsed: true }),
    SSR: folder({
      // SSREffect extends SSGIEffect — all SSGI options apply.
      ssrEnabled: { value: false, label: 'on (inherits all SSGI params above)' },
    }, { collapsed: true }),
    'Motion Blur': folder({
      motionBlurEnabled: { value: false, label: 'on' },
      motionBlurIntensity: { value: 1, min: 0, max: 4, step: 0.05, label: 'intensity' },
      motionBlurJitter: { value: 1, min: 0, max: 4, step: 0.05, label: 'jitter' },
      motionBlurSamples: { value: 16, min: 4, max: 64, step: 1, label: 'samples' },
    }, { collapsed: true }),
  })

  // Live-tune the renderer's tone-mapping exposure. ACES compresses highlights,
  // so this is the knob to keep bright zones from feeling dim.
  useEffect(() => {
    gl.toneMappingExposure = exposure
  }, [gl, exposure])

  // DoF target — world-space point the effect focuses on.
  //   • cursor off planet → ease toward planet origin (whole planet sharp)
  //   • cursor on planet  → ease toward the raycast hit (uHudCursor)
  // Interaction.tsx publishes hudUniforms.uHudCursor + uHudCursorActive on
  // every pointermove raycast; TutorialHint publishes them when the tutorial
  // is up. Either signal drives the focus naturally.
  //
  // We attach the target VECTOR3 IMPERATIVELY via a ref (useLayoutEffect)
  // rather than the <DepthOfField target={vec3}> prop. The React wrapper
  // conditionally replaces the Vector3 on each prop-diff which breaks
  // the in-place-mutation pattern this useFrame relies on. Direct .target
  // assignment on the effect instance is stable across re-renders.
  const dofRef = useRef<DepthOfFieldEffect | null>(null)
  const dofTarget = useMemo(() => new THREE.Vector3(), [])
  const dofDesired = useMemo(() => new THREE.Vector3(), [])

  useLayoutEffect(() => {
    if (!dofEnabled || !dofRef.current) return
    dofRef.current.target = dofTarget
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__dofEffect = dofRef.current
      ;(window as unknown as Record<string, unknown>).__dofTarget = dofTarget
    }
    return () => {
      if (dofRef.current) dofRef.current.target = null
    }
  }, [dofEnabled, dofTarget])

  useFrame(() => {
    if (!dofEnabled || !dofRef.current) return
    const active = hudUniforms.uHudCursorActive.value > 0 && dofFollowCursor
    if (active) dofDesired.copy(hudUniforms.uHudCursor.value)
    else dofDesired.set(0, 0, 0)
    // Frame-rate-independent ease: the same `dofSmoothing` feels the same
    // at 30 or 120 fps. Clamp to 1 so the max smoothing snaps instantly.
    dofTarget.lerp(dofDesired, Math.min(1, dofSmoothing))
  })

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

  // enableNormalPass is needed by SSGI's G-buffer reads. Turning it on when
  // SSGI is off is a minor waste (~one extra render pass) — leave it gated
  // so the common Path-1 case stays cheap.
  const needNormalPass = ssgiEnabled || ssrEnabled

  return (
    <EffectComposer multisampling={0} enableNormalPass={needNormalPass}>
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
          ref={dofRef}
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
      <RealismFX
        ssgi={ssgiEnabled}
        ssr={ssrEnabled}
        motionBlur={motionBlurEnabled}
        ssgiDistance={ssgiDistance}
        ssgiThickness={ssgiThickness}
        ssgiAutoThickness={ssgiAutoThickness}
        ssgiMaxRoughness={ssgiMaxRoughness}
        ssgiBlend={ssgiBlend}
        ssgiDenoiseIterations={ssgiDenoiseIterations}
        ssgiDenoiseKernel={ssgiDenoiseKernel}
        ssgiDenoiseDiffuse={ssgiDenoiseDiffuse}
        ssgiDenoiseSpecular={ssgiDenoiseSpecular}
        ssgiDepthPhi={ssgiDepthPhi}
        ssgiNormalPhi={ssgiNormalPhi}
        ssgiRoughnessPhi={ssgiRoughnessPhi}
        ssgiEnvBlur={ssgiEnvBlur}
        ssgiImportanceSampling={ssgiImportanceSampling}
        ssgiDirectLightMultiplier={ssgiDirectLightMultiplier}
        ssgiSteps={ssgiSteps}
        ssgiRefineSteps={ssgiRefineSteps}
        ssgiSpp={ssgiSpp}
        ssgiResolutionScale={ssgiResolutionScale}
        ssgiMissedRays={ssgiMissedRays}
        motionBlurIntensity={motionBlurIntensity}
        motionBlurJitter={motionBlurJitter}
        motionBlurSamples={motionBlurSamples}
      />
    </EffectComposer>
  )
}
