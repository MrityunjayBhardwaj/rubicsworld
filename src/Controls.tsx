import { useEffect } from 'react'
import { button, useControls } from 'leva'
import { usePlanet } from './world/store'
import { runRotationSelfTest } from './world/selfTest'

type PreviewMode = false | 'grid' | 'split' | 'cube'

export function Controls({
  dioramaPreview,
  setDioramaPreview,
}: {
  dioramaPreview: PreviewMode
  setDioramaPreview: (v: PreviewMode) => void
}) {
  const scramble = usePlanet(s => s.scrambleInstant)
  const scrambleAnimated = usePlanet(s => s.scrambleAnimated)
  const reset = usePlanet(s => s.reset)
  const solve = usePlanet(s => s.solve)
  const setShowLabels = usePlanet(s => s.setShowLabels)
  const setShowRing = usePlanet(s => s.setShowRing)
  const setCommitThreshold = usePlanet(s => s.setCommitThreshold)
  const setAiEnabled = usePlanet(s => s.setAiEnabled)

  useControls({
    'Diorama (grid)': button(() => setDioramaPreview(dioramaPreview === 'grid' ? false : 'grid')),
    'Diorama (split)': button(() => setDioramaPreview(dioramaPreview === 'split' ? false : 'split')),
    'Diorama (cube)': button(() => setDioramaPreview(dioramaPreview === 'cube' ? false : 'cube')),
    Ring: {
      value: false,
      onChange: (v: boolean) => setShowRing(v),
    },
    'Tile numbers': {
      value: false,
      onChange: (v: boolean) => setShowLabels(v),
    },
    'AI seed': {
      value: true,
      onChange: (v: boolean) => setAiEnabled(v),
    },
    'Commit threshold (°)': {
      value: 6.5,
      min: 3,
      max: 45,
      step: 0.5,
      onChange: (v: number) => setCommitThreshold((v * Math.PI) / 180),
    },
    Scramble: button(() => scramble(20)),
    'Scramble (animated)': button(() => void scrambleAnimated(20)),
    Solve: button(() => solve()),
    Reset: button(() => reset()),
    'Self-test (rotation math)': button(() => {
      const r = runRotationSelfTest(200, 30)
      const verdict = r.fail === 0 ? 'PASS' : 'FAIL'
      // eslint-disable-next-line no-console
      console.log(`[selftest] ${verdict}: pass=${r.pass} fail=${r.fail}`, r.sample ?? '')
    }),
  })

  useEffect(() => {
    const log = (name: string) => () => console.log(`[event] ${name}`)
    const handlers: Array<[string, () => void]> = [
      ['planet:settled', log('planet:settled')],
      ['planet:ai-pulse', log('planet:ai-pulse')],
      ['planet:ai-tone', log('planet:ai-tone')],
    ]
    for (const [name, h] of handlers) window.addEventListener(name, h)
    return () => {
      for (const [name, h] of handlers) window.removeEventListener(name, h)
    }
  }, [])

  return null
}
