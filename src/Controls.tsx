import { useEffect } from 'react'
import { button, useControls } from 'leva'
import { usePlanet } from './world/store'
import { runRotationSelfTest } from './world/selfTest'

export function Controls() {
  const scramble = usePlanet(s => s.scrambleInstant)
  const scrambleAnimated = usePlanet(s => s.scrambleAnimated)
  const reset = usePlanet(s => s.reset)
  const setShowLabels = usePlanet(s => s.setShowLabels)
  const setShowRing = usePlanet(s => s.setShowRing)
  const setCommitThreshold = usePlanet(s => s.setCommitThreshold)

  useControls({
    Ring: {
      value: false,
      onChange: (v: boolean) => setShowRing(v),
    },
    'Tile numbers': {
      value: false,
      onChange: (v: boolean) => setShowLabels(v),
    },
    'Commit threshold (°)': {
      value: 22.5,
      min: 5,
      max: 45,
      step: 0.5,
      onChange: (v: number) => setCommitThreshold((v * Math.PI) / 180),
    },
    Scramble: button(() => scramble(20)),
    'Scramble (animated)': button(() => void scrambleAnimated(20)),
    Reset: button(() => reset()),
    'Self-test (rotation math)': button(() => {
      const r = runRotationSelfTest(200, 30)
      const verdict = r.fail === 0 ? 'PASS' : 'FAIL'
      // eslint-disable-next-line no-console
      console.log(`[selftest] ${verdict}: pass=${r.pass} fail=${r.fail}`, r.sample ?? '')
    }),
  })

  useEffect(() => {
    const handler = () => console.log('[event] planet:settled')
    window.addEventListener('planet:settled', handler)
    return () => window.removeEventListener('planet:settled', handler)
  }, [])

  return null
}
