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
 * STATUS (2026-04-20): GLSL-level blocker. SSGI / SSR crash the renderer on
 * three 0.183 because realism-effects' hand-written fragment shader calls
 * tone-mapping functions (LinearToneMapping, ReinhardToneMapping, ACES...)
 * that three's shader chunks no longer expose by those names. Toggling
 * motion blur alone may work (no tone-mapping shader dep) — untested.
 *
 * Resolution paths:
 *   1. Wait for realism-effects v2 to publish a version targeting three
 *      0.163+ (tracked — main branch peer still ^0.151.3 as of now).
 *   2. Wait for pmndrs/postprocessing#599 native SSGI to ship.
 *   3. Fork realism-effects and rewrite the GLSL tone-mapping block to
 *      use three's current shader chunks. ~1 day of work, ongoing
 *      maintenance burden.
 *
 * The 5-patch stack in patches/realism-effects+1.1.2.patch already covers:
 *   • WebGLMultipleRenderTargets → WebGLRenderTarget({count})  (removed r163)
 *   • .texture[i] / .texture.map / .push etc. → .textures
 *   • renderer.copyFramebufferToTexture arg order (swapped r163)
 *
 * That gets the module to LOAD and lets motion blur + infra sit ready.
 * SSGI/SSR render path crashes on first composer tick.
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
  // SSGI options
  ssgiDistance: number
  ssgiThickness: number
  ssgiBlend: number
  ssgiDenoiseIterations: number
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
    blend: props.ssgiBlend,
    denoiseIterations: props.ssgiDenoiseIterations,
  }), [props.ssgiDistance, props.ssgiThickness, props.ssgiBlend, props.ssgiDenoiseIterations])

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
    // @ts-expect-error postprocessing's EffectPass accepts variadic effects
    const effectPass = new EffectPass(camera, ...effects)
    composer.addPass(effectPass, 2)

    return () => {
      composer.removePass(velPass)
      composer.removePass(effectPass)
      velPass.dispose?.()
      effectPass.dispose?.()
      for (const e of effects) (e as { dispose?: () => void }).dispose?.()
    }
  }, [composer, scene, camera, props.ssgi, props.ssr, props.motionBlur, ssgiOpts, motionOpts])

  return null
}
