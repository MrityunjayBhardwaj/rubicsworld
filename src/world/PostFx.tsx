import { useEffect, useRef, useState } from 'react'
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
 * Ordering rationale:
 *   SMAA first so later passes operate on anti-aliased color
 *   N8AO early — occlusion multiplies color, should land before bloom boost
 *   DoF before bloom so bloom doesn't bleed through blurred regions
 *   Bloom before noise/vignette so the grain + edge darkness read on top
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

  const bloomIntensity = lerp(0.35, 0.95, warmth)
  const vignetteDarkness = lerp(0.45, 0.62, warmth)

  return (
    <EffectComposer multisampling={0}>
      <SMAA />
      {/* N8AO — grounds diorama props (huts, trees, well, bridge) to terrain.
          Tuned subtle for the stylized scale (unit sphere, tiny props): too
          strong and the triplanar grass gets crushed. */}
      <N8AO aoRadius={0.15} intensity={1.4} distanceFalloff={0.5} quality="medium" />
      {/* DoF — subtle focus on the planet centre. focusDistance is in
          normalised camera space (0=near, 1=far). Planet sits at roughly
          0.015 with our near=0.01 far=default. Keep focalLength generous
          and bokehScale small so the diorama stays readable — strong DoF
          smears the low-poly silhouettes. */}
      <DepthOfField focusDistance={0.018} focalLength={0.12} bokehScale={1.4} />
      <Bloom
        intensity={bloomIntensity}
        luminanceThreshold={0.55}
        luminanceSmoothing={0.4}
        mipmapBlur
      />
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.08} />
      <Vignette darkness={vignetteDarkness} offset={0.3} eskil={false} />
    </EffectComposer>
  )
}
