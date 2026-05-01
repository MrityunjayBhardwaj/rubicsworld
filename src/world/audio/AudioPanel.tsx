// Leva 'Audio' folder with master + per-category controls + per-sound rows
// generated from the registry. Each loop and event gets its own mute / vol /
// speed triplet that writes into the audioBus override maps.
//
// Settings persistence: every change writes the panel state to localStorage
// so a page reload restores it. Save/Load/Reset buttons in the panel allow
// explicit JSON export, file-picker import, and clearing back to defaults.

import { useControls, folder, button } from 'leva'
import { useEffect, useRef } from 'react'
import { audioBus, REGISTRY } from './bus'
import { useAudioUi } from './audioUiStore'
import {
  defaultsFlat,
  downloadJson,
  loadFromLocalStorage,
  persistToLocalStorage,
  pickAndApply,
  flatten,
  copyToClipboard,
} from './audioSettings'

function buildLoopRows() {
  const rows: Record<string, unknown> = {}
  for (const def of REGISTRY.loops) {
    rows[`${def.key}__mute`]  = { value: false, label: `${def.key} mute` }
    rows[`${def.key}__vol`]   = { value: 1.0, min: 0, max: 1.0, step: 0.01, label: `${def.key} vol` }
    rows[`${def.key}__speed`] = { value: 1.0, min: 0.5, max: 2.0, step: 0.01, label: `${def.key} speed` }
    // Radius slider only for positional loops where a reach is defined.
    // World/camera_motion anchors have no spatial extent.
    const baseRadius = def.radius ?? def.maxDist
    if (def.anchor.startsWith('object:') && baseRadius != null) {
      rows[`${def.key}__radius`] = { value: baseRadius, min: 0, max: 50, step: 0.5, label: `${def.key} radius` }
    }
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

  // Function form returns [values, setLeva] so we can write Loaded JSON
  // back into the UI after a file pick / Reset.
  const [v, setLeva] = useControls('Audio', () => ({
    save:    button(() => downloadJson(latestRef.current)),
    load:    button(() => void pickAndApply(flat => {
      // setLeva accepts a flat key→value map; per-key try/catch in case the
      // JSON references an old key that's no longer in the registry.
      for (const [k, val] of Object.entries(flat)) {
        try { setLeva({ [k]: val }) }
        catch { /* unknown key — skip */ }
      }
    })),
    copy:    button(() => void copyToClipboard(latestRef.current)),
    reset:   button(() => {
      const flat = defaultsFlat()
      for (const [k, val] of Object.entries(flat)) {
        try { setLeva({ [k]: val }) }
        catch { /* skip */ }
      }
    }),
    masterMute:    { value: false, label: 'mute' },
    masterVol:     { value: 1.0,   min: 0, max: 1.0, step: 0.01, label: 'master vol' },
    ambientMute:   { value: false, label: 'ambient mute' },
    ambientVol:    { value: 1.0,   min: 0, max: 1.0, step: 0.01, label: 'ambient vol' },
    sfxMute:       { value: false, label: 'sfx mute' },
    sfxVol:        { value: 1.0,   min: 0, max: 1.0, step: 0.01, label: 'sfx vol' },
    showVisualizer:{ value: false, label: 'show sound debug' },
    Loops:  folder(buildLoopRows()  as Parameters<typeof folder>[0], { collapsed: true }),
    Events: folder(buildEventRows() as Parameters<typeof folder>[0], { collapsed: true }),
  }), { collapsed: true })

  // Flatten the Leva return — folder children are nested in the schema but
  // appear flat in the values map. Cast through unknown because the schema
  // shape includes Folder inputs that aren't boolean | number.
  const values = v as unknown as Record<string, boolean | number>
  const latestRef = useRef(values)
  latestRef.current = values

  // One-shot: load persisted settings from localStorage on first render.
  // Run BEFORE the per-row useEffects fire so the bus picks up the loaded
  // state without flashing defaults first.
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    const persisted = loadFromLocalStorage()
    if (!persisted) return
    const flat = flatten(persisted)
    for (const [k, val] of Object.entries(flat)) {
      try { setLeva({ [k]: val }) }
      catch { /* unknown key — skip */ }
    }
  }, [setLeva])

  // Master + category — write on every value change.
  useEffect(() => { audioBus.setMasterMute(values.masterMute as boolean) },                [values.masterMute])
  useEffect(() => { audioBus.setMasterVolume(values.masterVol as number) },                [values.masterVol])
  useEffect(() => { audioBus.setCategoryMute('ambient', values.ambientMute as boolean) },  [values.ambientMute])
  useEffect(() => { audioBus.setCategoryVolume('ambient', values.ambientVol as number) },  [values.ambientVol])
  useEffect(() => { audioBus.setCategoryMute('sfx', values.sfxMute as boolean) },          [values.sfxMute])
  useEffect(() => { audioBus.setCategoryVolume('sfx', values.sfxVol as number) },          [values.sfxVol])
  useEffect(() => { setShowVisualizer(values.showVisualizer as boolean) },                 [values.showVisualizer, setShowVisualizer])

  // Per-sound rows — single effect dispatches all overrides; persists JSON
  // to localStorage so a reload restores the panel state.
  useEffect(() => {
    for (const def of REGISTRY.loops) {
      const baseRadius = def.radius ?? def.maxDist
      const hasRadiusRow = def.anchor.startsWith('object:') && baseRadius != null
      audioBus.setLoopOverride(def.key, {
        mute:  values[`${def.key}__mute`]  as boolean,
        vol:   values[`${def.key}__vol`]   as number,
        speed: values[`${def.key}__speed`] as number,
        ...(hasRadiusRow ? { radius: values[`${def.key}__radius`] as number } : {}),
      })
    }
    for (const def of REGISTRY.events) {
      audioBus.setEventOverride(def.key, {
        mute:  values[`${def.key}__mute`]  as boolean,
        vol:   values[`${def.key}__vol`]   as number,
        speed: values[`${def.key}__speed`] as number,
      })
    }
    persistToLocalStorage(values)
  }, [values])

  return null
}
