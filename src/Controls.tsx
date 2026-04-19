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
  const solveAnimated = usePlanet(s => s.solveAnimated)
  const setShowLabels = usePlanet(s => s.setShowLabels)
  const setShowRing = usePlanet(s => s.setShowRing)
  const setCommitThreshold = usePlanet(s => s.setCommitThreshold)
  const setAiEnabled = usePlanet(s => s.setAiEnabled)
  const setEasyMode = usePlanet(s => s.setEasyMode)
  const setCameraMode = usePlanet(s => s.setCameraMode)

  useControls({
    'View: Cube net': button(() => setDioramaPreview(dioramaPreview === 'grid' ? false : 'grid')),
    'View: Split': button(() => setDioramaPreview(dioramaPreview === 'split' ? false : 'split')),
    'View: Cube': button(() => setDioramaPreview(dioramaPreview === 'cube' ? false : 'cube')),
    'View: Sphere (planet)': button(() => setDioramaPreview(false)),
    'Walk on planet': button(() => {
      // Must stay in sphere mode — WalkControls only mounts under <Canvas>'s
      // sphere branch.
      setDioramaPreview(false)
      setCameraMode('walk')
    }),
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
    'Easy mode (HUD hints)': {
      value: false,
      onChange: (v: boolean) => setEasyMode(v),
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
    'Solve (animated)': button(() => void solveAnimated()),
    Reset: button(() => reset()),
    'Replay tutorial (reload)': button(() => {
      // Dev aid: clear the tutorialSeen flag and reload so the onboarding
      // tutorial plays again from the top. Used to test the flow without
      // clearing localStorage manually.
      try { localStorage.removeItem('rubicsworld:tutorialSeen') } catch { /* ignore */ }
      window.location.reload()
    }),
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
