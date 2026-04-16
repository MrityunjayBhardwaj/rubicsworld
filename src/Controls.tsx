import { useEffect } from 'react'
import { button, useControls } from 'leva'
import { usePlanet } from './world/store'
import { runRotationSelfTest } from './world/selfTest'

export function Controls() {
  const scramble = usePlanet(s => s.scrambleAnimated)
  const reset = usePlanet(s => s.reset)
  const rotateInstant = usePlanet(s => s.rotateInstant)
  const setShowLabels = usePlanet(s => s.setShowLabels)

  useControls({
    'Tile numbers': {
      value: true,
      onChange: (v: boolean) => setShowLabels(v),
    },
    Scramble: button(() => void scramble(20)),
    Reset: button(() => reset()),
    'Self-test (rotation math)': button(() => {
      const r = runRotationSelfTest(200, 30)
      const verdict = r.fail === 0 ? 'PASS' : 'FAIL'
      // eslint-disable-next-line no-console
      console.log(`[selftest] ${verdict}: pass=${r.pass} fail=${r.fail}`, r.sample ?? '')
    }),
    'X+ slice 0': button(() => rotateInstant({ axis: 'x', slice: 0, dir: 1 })),
    'Y+ slice 1': button(() => rotateInstant({ axis: 'y', slice: 1, dir: 1 })),
  })

  useEffect(() => {
    const handler = () => console.log('[event] planet:settled')
    window.addEventListener('planet:settled', handler)
    return () => window.removeEventListener('planet:settled', handler)
  }, [])

  return null
}
