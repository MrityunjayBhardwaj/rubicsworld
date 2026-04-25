// Leva 'Audio' folder with master + per-category controls + per-sound rows
// generated from the registry. Each loop and event gets its own mute / vol /
// speed triplet that writes into the audioBus override maps.

import { useControls, folder } from 'leva'
import { useEffect } from 'react'
import { audioBus, REGISTRY } from './bus'
import { useAudioUi } from './audioUiStore'

// Build the schema once at module init from REGISTRY. Each row produces three
// keys: <key>__mute / <key>__vol / <key>__speed so the values destructure
// cleanly without needing folder paths.
function buildLoopRows() {
  const rows: Record<string, unknown> = {}
  for (const def of REGISTRY.loops) {
    rows[`${def.key}__mute`]  = { value: false, label: `${def.key} mute` }
    rows[`${def.key}__vol`]   = { value: 1.0, min: 0, max: 1.0, step: 0.01, label: `${def.key} vol` }
    rows[`${def.key}__speed`] = { value: 1.0, min: 0.5, max: 2.0, step: 0.01, label: `${def.key} speed` }
  }
  return rows
}
function buildEventRows() {
  const rows: Record<string, unknown> = {}
  for (const def of REGISTRY.events) {
    rows[`${def.key}__mute`]  = { value: false, label: `${def.key} mute` }
    rows[`${def.key}__vol`]   = { value: 1.0, min: 0, max: 1.0, step: 0.01, label: `${def.key} vol` }
    rows[`${def.key}__speed`] = { value: 1.0, min: 0.5, max: 2.0, step: 0.01, label: `${def.key} speed` }
  }
  return rows
}

export function AudioPanel() {
  const setShowVisualizer = useAudioUi(s => s.setShowVisualizer)

  const v = useControls('Audio', {
    masterMute:    { value: false, label: 'mute' },
    masterVol:     { value: 1.0,   min: 0, max: 1.0, step: 0.01, label: 'master vol' },
    ambientMute:   { value: false, label: 'ambient mute' },
    ambientVol:    { value: 1.0,   min: 0, max: 1.0, step: 0.01, label: 'ambient vol' },
    sfxMute:       { value: false, label: 'sfx mute' },
    sfxVol:        { value: 1.0,   min: 0, max: 1.0, step: 0.01, label: 'sfx vol' },
    showVisualizer:{ value: false, label: 'show sound debug' },
    Loops:  folder(buildLoopRows(),  { collapsed: true }),
    Events: folder(buildEventRows(), { collapsed: true }),
  }, { collapsed: true }) as Record<string, boolean | number>

  // Master + category — write on every value change.
  useEffect(() => { audioBus.setMasterMute(v.masterMute as boolean) },                [v.masterMute])
  useEffect(() => { audioBus.setMasterVolume(v.masterVol as number) },                [v.masterVol])
  useEffect(() => { audioBus.setCategoryMute('ambient', v.ambientMute as boolean) },  [v.ambientMute])
  useEffect(() => { audioBus.setCategoryVolume('ambient', v.ambientVol as number) },  [v.ambientVol])
  useEffect(() => { audioBus.setCategoryMute('sfx', v.sfxMute as boolean) },          [v.sfxMute])
  useEffect(() => { audioBus.setCategoryVolume('sfx', v.sfxVol as number) },          [v.sfxVol])
  useEffect(() => { setShowVisualizer(v.showVisualizer as boolean) },                 [v.showVisualizer, setShowVisualizer])

  // Per-sound rows. Single effect dispatching every loop's overrides — Leva
  // returns a fresh object each render so a [v] dep would re-fire constantly;
  // `v` doesn't change identity unless a key changed, so each row's effect
  // only re-runs when its specific value flipped.
  useEffect(() => {
    for (const def of REGISTRY.loops) {
      audioBus.setLoopOverride(def.key, {
        mute:  v[`${def.key}__mute`]  as boolean,
        vol:   v[`${def.key}__vol`]   as number,
        speed: v[`${def.key}__speed`] as number,
      })
    }
    for (const def of REGISTRY.events) {
      audioBus.setEventOverride(def.key, {
        mute:  v[`${def.key}__mute`]  as boolean,
        vol:   v[`${def.key}__vol`]   as number,
        speed: v[`${def.key}__speed`] as number,
      })
    }
  }, [v])

  return null
}
