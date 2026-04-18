import { useEffect, useRef, useState } from 'react'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import { usePlanet } from './store'

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t)
}

const WARM_DURATION_MS = 2000

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
    <EffectComposer>
      <Bloom
        intensity={bloomIntensity}
        luminanceThreshold={0.55}
        luminanceSmoothing={0.4}
        mipmapBlur
      />
      <Vignette darkness={vignetteDarkness} offset={0.3} eskil={false} />
    </EffectComposer>
  )
}
