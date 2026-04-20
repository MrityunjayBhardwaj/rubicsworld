import { useContext, useEffect, useMemo } from 'react'
import { EffectComposerContext } from '@react-three/postprocessing'
import { EffectPass } from 'postprocessing'
import {
  VelocityDepthNormalPass,
  SSGIEffect,
  SSREffect,
  MotionBlurEffect,
  // @ts-expect-error realism-effects ships no types
} from 'realism-effects'

/**
 * Path-2 escape hatch — mount this as a child of <EffectComposer> to layer
 * realism-effects' SSGI / SSR / motion-blur on top of the pmndrs chain.
 *
 * ────────────────────────────────────────────────────────────────────────
 * STATUS (2026-04-20): Working on three 0.183 ✓
 *   • Motion Blur — works
 *   • SSGI — works
 *   • SSR — works (inherits SSGIEffect's shader path)
 *
 * Patches applied (patches/realism-effects+1.1.2.patch):
 *   • WebGLMultipleRenderTargets → WebGLRenderTarget({ count, ...opts })
 *     (removed from three r163)
 *   • .texture[i] / .map / .push / .length / Array.isArray(.texture) →
 *     .textures.* (RT API change: .texture is now a scalar getter)
 *   • renderer.copyFramebufferToTexture(pos, tex) → (tex, pos) (r163 swap)
 *   • GLSL: OptimizedCineonToneMapping → CineonToneMapping (r163 rename)
 *
 * Pass layout: one EffectPass PER realism effect, not merged. Merging
 * SSGI + SSR into one EffectPass produces duplicate tonemapping_pars_fragment
 * chunk inclusions → redefinition errors. Separate passes compile cleanly.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Why a manual escape hatch: realism-effects ships no React wrappers and
 * does not speak @react-three/postprocessing's JSX-children merging. We pull
 * the raw postprocessing composer + scene + camera from EffectComposerContext,
 * imperatively add a VelocityDepthNormalPass (shared G-buffer) + a single
 * EffectPass that merges whichever realism effects are enabled.
 *
 * Patching: realism-effects 1.1.2 imports `WebGLMultipleRenderTargets`, which
 * three.js removed in r163. We patch-package in /patches to rewrite those
 * call sites to `new WebGLRenderTarget(w, h, {count, ...opts})`. The patch
 * also remaps `renderTarget.texture[i]` → `renderTarget.textures[i]` to
 * match the new RT API. See patches/realism-effects+1.1.2.patch.
 *
 * Ordering inside the drei composer: the VelocityDepthNormalPass must run
 * before anything that reads it, and the realism EffectPass must run before
 * the merged JSX children so SSGI's contribution feeds Bloom. We addPass at
 * index 1 (after RenderPass at 0) and index 2.
 *
 * Gate: usePlanet.sceneGrade === 'photoreal' — when the Blender photoreal
 * diorama lands, flip the grade to light this up.
 */

export interface RealismFXProps {
  ssgi: boolean
  ssr: boolean
  motionBlur: boolean
  // SSGI options — SSR shares all of these (SSREffect extends SSGIEffect).
  ssgiDistance: number
  ssgiThickness: number
  ssgiAutoThickness: boolean
  ssgiMaxRoughness: number
  ssgiBlend: number
  ssgiDenoiseIterations: number
  ssgiDenoiseKernel: number
  ssgiDenoiseDiffuse: number
  ssgiDenoiseSpecular: number
  ssgiDepthPhi: number
  ssgiNormalPhi: number
  ssgiRoughnessPhi: number
  ssgiEnvBlur: number
  ssgiImportanceSampling: boolean
  ssgiDirectLightMultiplier: number
  ssgiSteps: number
  ssgiRefineSteps: number
  ssgiSpp: number
  ssgiResolutionScale: number
  ssgiMissedRays: boolean
  // MotionBlur options
  motionBlurIntensity: number
  motionBlurJitter: number
  motionBlurSamples: number
}

export function RealismFX(props: RealismFXProps) {
  const { composer, scene, camera } = useContext(EffectComposerContext)

  // Stabilise the option-object identity so the effect doesn't re-create
  // passes every parameter tweak (Leva slider drags re-render this component
  // 60 Hz — re-creating GL passes that fast leaks textures).
  const ssgiOpts = useMemo(() => ({
    distance: props.ssgiDistance,
    thickness: props.ssgiThickness,
    autoThickness: props.ssgiAutoThickness,
    maxRoughness: props.ssgiMaxRoughness,
    blend: props.ssgiBlend,
    denoiseIterations: props.ssgiDenoiseIterations,
    denoiseKernel: props.ssgiDenoiseKernel,
    denoiseDiffuse: props.ssgiDenoiseDiffuse,
    denoiseSpecular: props.ssgiDenoiseSpecular,
    depthPhi: props.ssgiDepthPhi,
    normalPhi: props.ssgiNormalPhi,
    roughnessPhi: props.ssgiRoughnessPhi,
    envBlur: props.ssgiEnvBlur,
    importanceSampling: props.ssgiImportanceSampling,
    directLightMultiplier: props.ssgiDirectLightMultiplier,
    steps: props.ssgiSteps,
    refineSteps: props.ssgiRefineSteps,
    spp: props.ssgiSpp,
    resolutionScale: props.ssgiResolutionScale,
    missedRays: props.ssgiMissedRays,
  }), [
    props.ssgiDistance, props.ssgiThickness, props.ssgiAutoThickness,
    props.ssgiMaxRoughness, props.ssgiBlend, props.ssgiDenoiseIterations,
    props.ssgiDenoiseKernel, props.ssgiDenoiseDiffuse, props.ssgiDenoiseSpecular,
    props.ssgiDepthPhi, props.ssgiNormalPhi, props.ssgiRoughnessPhi,
    props.ssgiEnvBlur, props.ssgiImportanceSampling, props.ssgiDirectLightMultiplier,
    props.ssgiSteps, props.ssgiRefineSteps, props.ssgiSpp,
    props.ssgiResolutionScale, props.ssgiMissedRays,
  ])

  const motionOpts = useMemo(() => ({
    intensity: props.motionBlurIntensity,
    jitter: props.motionBlurJitter,
    samples: props.motionBlurSamples,
  }), [props.motionBlurIntensity, props.motionBlurJitter, props.motionBlurSamples])

  useEffect(() => {
    if (!props.ssgi && !props.ssr && !props.motionBlur) return

    const velPass = new VelocityDepthNormalPass(scene, camera)
    const effects: unknown[] = []

    if (props.ssgi) {
      const ssgi = new SSGIEffect(scene, camera, velPass, ssgiOpts)
      effects.push(ssgi)
    }
    if (props.ssr) {
      const ssr = new SSREffect(scene, camera, velPass, ssgiOpts)
      effects.push(ssr)
    }
    if (props.motionBlur) {
      const mb = new MotionBlurEffect(velPass, motionOpts)
      effects.push(mb)
    }

    if (effects.length === 0) {
      velPass.dispose?.()
      return
    }

    composer.addPass(velPass, 1)
    // One EffectPass per realism effect — SSGI and SSR both include the
    // tonemapping_pars_fragment chunk, so merging them into a single
    // EffectPass produces duplicate function definitions at shader-compile
    // time. Separate passes = slower but each compiles in its own scope.
    const passes: { dispose?: () => void }[] = []
    effects.forEach((e, i) => {
      // @ts-expect-error postprocessing accepts a single effect
      const p = new EffectPass(camera, e)
      composer.addPass(p, 2 + i)
      passes.push(p)
    })

    return () => {
      composer.removePass(velPass)
      for (const p of passes) {
        composer.removePass(p as never)
        p.dispose?.()
      }
      velPass.dispose?.()
      for (const e of effects) (e as { dispose?: () => void }).dispose?.()
    }
  }, [composer, scene, camera, props.ssgi, props.ssr, props.motionBlur, ssgiOpts, motionOpts])

  return null
}
