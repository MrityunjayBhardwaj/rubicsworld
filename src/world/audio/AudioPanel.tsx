// Leva Audio folder: master mute/volume + per-category vol/mute. Writes
// directly into the audioBus. Panel is plain HTML-side (sits next to
// HDRIPanel / GrassPanel) so it does not depend on the Canvas tree.

import { useControls } from 'leva'
import { useEffect } from 'react'
import { audioBus } from './bus'

export function AudioPanel() {
  const v = useControls('Audio', {
    masterMute:   { value: false, label: 'mute' },
    masterVol:    { value: 1.0, min: 0, max: 1.0, step: 0.01, label: 'master volume' },
    ambientMute:  { value: false, label: 'ambient mute' },
    ambientVol:   { value: 1.0, min: 0, max: 1.0, step: 0.01, label: 'ambient volume' },
    sfxMute:      { value: false, label: 'sfx mute' },
    sfxVol:       { value: 1.0, min: 0, max: 1.0, step: 0.01, label: 'sfx volume' },
  }, { collapsed: true })

  useEffect(() => { audioBus.setMasterMute(v.masterMute) }, [v.masterMute])
  useEffect(() => { audioBus.setMasterVolume(v.masterVol) }, [v.masterVol])
  useEffect(() => { audioBus.setCategoryMute('ambient', v.ambientMute) }, [v.ambientMute])
  useEffect(() => { audioBus.setCategoryVolume('ambient', v.ambientVol) }, [v.ambientVol])
  useEffect(() => { audioBus.setCategoryMute('sfx', v.sfxMute) }, [v.sfxMute])
  useEffect(() => { audioBus.setCategoryVolume('sfx', v.sfxVol) }, [v.sfxVol])

  return null
}
