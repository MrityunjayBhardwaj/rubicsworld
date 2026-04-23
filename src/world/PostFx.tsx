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
  SSAO,
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
    n8aoEnabled, n8aoRadius, n8aoScreenSpaceRadius, n8aoIntensity, n8aoFalloff,
    n8aoSamples, n8aoDenoiseSamples, n8aoDenoiseRadius, n8aoHalfRes,
    n8aoColor, n8aoRenderMode, n8aoQuality,
    dofEnabled, dofFollowCursor, dofFocusRangeOnCursor, dofFocusRangeWholePlanet,
    dofBokehScale, dofSmoothing, dofDebugTarget,
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
    ssaoEnabled, ssaoSamples, ssaoRings, ssaoRadius, ssaoIntensity,
    ssaoLuminanceInfluence, ssaoBias, ssaoFade, ssaoColor,
    ssaoWorldDistanceThreshold, ssaoWorldDistanceFalloff,
    ssaoWorldProximityThreshold, ssaoWorldProximityFalloff,
    ssaoResolutionScale,
  } = useControls('PostFx', {
    exposure: { value: 1.35, min: 0.3, max: 3, step: 0.05, label: 'Exposure (ACES)' },
    SMAA: folder({
      smaaEnabled: { value: true, label: 'on' },
    }, { collapsed: true }),
    N8AO: folder({
      n8aoEnabled: { value: true, label: 'on' },
      // aoRadius is in WORLD units (unless screenSpaceRadius is on). Our
      // planet is 2m diameter with props sticking out up to ~0.3m — a 0.5m
      // occlusion kernel gives visible grounding around their bases.
      n8aoRadius: { value: 0.5, min: 0.01, max: 5, step: 0.01, label: 'radius (world)' },
      n8aoScreenSpaceRadius: { value: false, label: 'radius in screen px' },
      n8aoIntensity: { value: 3, min: 0, max: 16, step: 0.1, label: 'intensity' },
      n8aoFalloff: { value: 1, min: 0, max: 3, step: 0.05, label: 'distance falloff' },
      n8aoSamples: { value: 16, min: 4, max: 64, step: 1, label: 'ao samples' },
      n8aoDenoiseSamples: { value: 4, min: 1, max: 16, step: 1, label: 'denoise samples' },
      n8aoDenoiseRadius: { value: 12, min: 1, max: 32, step: 1, label: 'denoise radius' },
      n8aoHalfRes: { value: false, label: 'half-res (faster, softer)' },
      n8aoColor: { value: '#000000', label: 'AO colour' },
      n8aoRenderMode: {
        value: 'Combined',
        options: ['Combined', 'AO', 'No AO', 'Split', 'Split AO'],
        label: 'render mode',
      },
      n8aoQuality: {
        value: 'medium',
        options: ['performance', 'low', 'medium', 'high', 'ultra'],
        label: 'quality preset',
      },
    }, { collapsed: true }),
    // SSAO — pmndrs' classic hemispherical-sample SSAO. Works on our scene
    // where N8AO's depth-derived normal reconstruction doesn't (sphere
    // projection vertex shader defeats the neighbour-delta trick). Toggle
    // on alongside or instead of N8AO.
    SSAO: folder({
      ssaoEnabled: { value: false, label: 'on' },
      ssaoSamples: { value: 30, min: 1, max: 64, step: 1, label: 'samples' },
      ssaoRings: { value: 4, min: 1, max: 16, step: 1, label: 'rings' },
      ssaoRadius: { value: 0.1, min: 0.001, max: 2, step: 0.001, label: 'radius' },
      ssaoIntensity: { value: 30, min: 0, max: 100, step: 0.5, label: 'intensity' },
      ssaoLuminanceInfluence: { value: 0.6, min: 0, max: 1, step: 0.01, label: 'lum influence' },
      ssaoBias: { value: 0.025, min: 0, max: 0.5, step: 0.001, label: 'bias' },
      ssaoFade: { value: 0.01, min: 0, max: 0.5, step: 0.001, label: 'fade' },
      ssaoColor: { value: '#000000', label: 'AO colour' },
      ssaoResolutionScale: { value: 1, min: 0.25, max: 1, step: 0.05, label: 'res scale' },
      'SSAO — world distance': folder({
        ssaoWorldDistanceThreshold: { value: 1, min: 0, max: 10, step: 0.05, label: 'dist threshold' },
        ssaoWorldDistanceFalloff: { value: 0.1, min: 0, max: 5, step: 0.05, label: 'dist falloff' },
        ssaoWorldProximityThreshold: { value: 0.4, min: 0, max: 5, step: 0.01, label: 'prox threshold' },
        ssaoWorldProximityFalloff: { value: 0.1, min: 0, max: 5, step: 0.01, label: 'prox falloff' },
      }, { collapsed: true }),
    }, { collapsed: true }),
    'Depth of Field': folder({
      dofEnabled: { value: true, label: 'on' },
      dofFollowCursor: { value: true, label: 'follow cursor (else planet)' },
      // Two focus-slab widths in world units (postprocessing 6.x
      // `worldFocusRange`). On-cursor: narrow so bokeh is visible on the
      // rest of the planet. Whole-planet: ≥ planet diameter (~2m) so the
      // entire body stays sharp when the cursor isn't on it.
      dofFocusRangeOnCursor: { value: 0.5, min: 0.05, max: 5, step: 0.05, label: 'range on hover (m)' },
      dofFocusRangeWholePlanet: { value: 3.0, min: 0.5, max: 10, step: 0.05, label: 'range full planet (m)' },
      dofBokehScale: { value: 1.0, min: 0, max: 8, step: 0.1, label: 'bokeh' },
      dofSmoothing: { value: 0.18, min: 0.01, max: 1, step: 0.01, label: 'follow speed' },
      dofDebugTarget: { value: false, label: 'debug: show target' },
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
  // Eased focus-range value driven imperatively. Owning this in a ref (and
  // NOT passing worldFocusRange as a prop) keeps it stable across the
  // wrapper's re-instantiation cycles (P4) — same pattern as `target`.
  const dofRangeRef = useRef(dofFocusRangeWholePlanet)

  // Dev hooks — attached once.
  useLayoutEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__dofTarget = dofTarget
    }
  }, [dofTarget])

  // Debug sphere position ref — drives a <mesh> whose position tracks dofTarget.
  const debugMeshRef = useRef<THREE.Mesh | null>(null)
  // Dev hook for N8AO pass introspection.
  const n8aoRef = useRef<unknown>(null)
  useLayoutEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__n8ao = n8aoRef.current
    }
  })

  useFrame(() => {
    if (!dofEnabled || !dofRef.current) return

    // @react-three/postprocessing's DoF wrapper re-instantiates its internal
    // effect whenever any config prop changes (worldFocusRange slider,
    // bokehScale, ...). The new instance's .target is reset to a placeholder
    // Vector3. Re-attach every frame if the ref has swapped out — cheap
    // identity check, keeps our lerp target wired to the live effect.
    if (dofRef.current.target !== dofTarget) {
      dofRef.current.target = dofTarget
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__dofEffect = dofRef.current
      }
    }

    const active = hudUniforms.uHudCursorActive.value > 0 && dofFollowCursor
    if (active) dofDesired.copy(hudUniforms.uHudCursor.value)
    else dofDesired.set(0, 0, 0)
    // Frame-rate-independent ease: the same `dofSmoothing` feels the same
    // at 30 or 120 fps. Clamp to 1 so the max smoothing snaps instantly.
    const ease = Math.min(1, dofSmoothing)
    dofTarget.lerp(dofDesired, ease)
    // Range eases between narrow (cursor on planet → bokeh visible) and
    // wide (cursor off planet → entire planet sharp around the origin).
    const targetRange = active ? dofFocusRangeOnCursor : dofFocusRangeWholePlanet
    dofRangeRef.current = THREE.MathUtils.lerp(dofRangeRef.current, targetRange, ease)
    dofRef.current.worldFocusRange = dofRangeRef.current
    if (debugMeshRef.current) debugMeshRef.current.position.copy(dofTarget)
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

  // enableNormalPass is needed by SSGI's G-buffer reads and by SSAO for
  // proper hemispherical sampling. Turning it on when none of those are
  // active is a minor waste (~one extra render pass).
  const needNormalPass = ssgiEnabled || ssrEnabled || ssaoEnabled

  return (
    <>
      {dofEnabled && dofDebugTarget ? (
        <mesh ref={debugMeshRef} renderOrder={9999}>
          <sphereGeometry args={[0.05, 16, 16]} />
          <meshBasicMaterial color="#ff00ff" depthTest={false} depthWrite={false} />
        </mesh>
      ) : null}
    <EffectComposer multisampling={0} enableNormalPass={needNormalPass} stencilBuffer depthBuffer>
      {smaaEnabled ? <SMAA /> : <></>}
      {n8aoEnabled ? (
        <N8AO
          ref={n8aoRef}
          aoRadius={n8aoRadius}
          screenSpaceRadius={n8aoScreenSpaceRadius}
          intensity={n8aoIntensity}
          distanceFalloff={n8aoFalloff}
          aoSamples={n8aoSamples}
          denoiseSamples={n8aoDenoiseSamples}
          denoiseRadius={n8aoDenoiseRadius}
          halfRes={n8aoHalfRes}
          color={n8aoColor}
          renderMode={
            n8aoRenderMode === 'AO' ? 1
              : n8aoRenderMode === 'No AO' ? 2
              : n8aoRenderMode === 'Split' ? 3
              : n8aoRenderMode === 'Split AO' ? 4
              : 0 /* Combined */
          }
          quality={n8aoQuality as 'performance' | 'low' | 'medium' | 'high' | 'ultra'}
        />
      ) : <></>}
      {ssaoEnabled ? (
        <SSAO
          samples={ssaoSamples}
          rings={ssaoRings}
          radius={ssaoRadius}
          intensity={ssaoIntensity}
          luminanceInfluence={ssaoLuminanceInfluence}
          bias={ssaoBias}
          fade={ssaoFade}
          color={ssaoColor}
          resolutionScale={ssaoResolutionScale}
          worldDistanceThreshold={ssaoWorldDistanceThreshold}
          worldDistanceFalloff={ssaoWorldDistanceFalloff}
          worldProximityThreshold={ssaoWorldProximityThreshold}
          worldProximityFalloff={ssaoWorldProximityFalloff}
        />
      ) : <></>}
      {dofEnabled ? (
        // worldFocusRange intentionally NOT passed — managed imperatively
        // each frame so the active vs. whole-planet ease survives the
        // wrapper's prop-diff re-instantiation cycle (P4).
        <DepthOfField
          ref={dofRef}
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
    </>
  )
}
