// Save / load helpers for the Audio panel. Mirrors the project's
// settings/index.ts pattern (download, pick-and-apply, copy-to-clipboard)
// scoped to audio. Also auto-persists to localStorage on every change so
// settings survive a page reload without an explicit Save click.

import { REGISTRY } from './bus'

export interface AudioSettings {
  version: 1
  master:  { mute: boolean; vol: number }
  ambient: { mute: boolean; vol: number }
  sfx:     { mute: boolean; vol: number }
  showVisualizer: boolean
  loops:   Record<string, { mute: boolean; vol: number; speed: number }>
  events:  Record<string, { mute: boolean; vol: number; speed: number }>
}

const STORAGE_KEY = 'rubicsworld.audio.v1'

type LevaValues = Record<string, boolean | number>

export function serialize(v: LevaValues): AudioSettings {
  const loops: AudioSettings['loops'] = {}
  for (const def of REGISTRY.loops) {
    loops[def.key] = {
      mute:  Boolean(v[`${def.key}__mute`]),
      vol:   Number(v[`${def.key}__vol`]   ?? 1),
      speed: Number(v[`${def.key}__speed`] ?? 1),
    }
  }
  const events: AudioSettings['events'] = {}
  for (const def of REGISTRY.events) {
    events[def.key] = {
      mute:  Boolean(v[`${def.key}__mute`]),
      vol:   Number(v[`${def.key}__vol`]   ?? 1),
      speed: Number(v[`${def.key}__speed`] ?? 1),
    }
  }
  return {
    version: 1,
    master:  { mute: Boolean(v.masterMute),  vol: Number(v.masterVol  ?? 1) },
    ambient: { mute: Boolean(v.ambientMute), vol: Number(v.ambientVol ?? 1) },
    sfx:     { mute: Boolean(v.sfxMute),     vol: Number(v.sfxVol     ?? 1) },
    showVisualizer: Boolean(v.showVisualizer),
    loops,
    events,
  }
}

// Flatten an AudioSettings object back into the per-key shape Leva expects.
// Skips keys that aren't currently in the registry — protects against stale
// saved files that reference removed loops/events (e.g. settle_chime).
export function flatten(s: AudioSettings): LevaValues {
  const out: LevaValues = {
    masterMute:  s.master.mute,
    masterVol:   s.master.vol,
    ambientMute: s.ambient.mute,
    ambientVol:  s.ambient.vol,
    sfxMute:     s.sfx.mute,
    sfxVol:      s.sfx.vol,
    showVisualizer: s.showVisualizer,
  }
  const live = new Set<string>([
    ...REGISTRY.loops.map(d => d.key),
    ...REGISTRY.events.map(d => d.key),
  ])
  for (const [key, row] of Object.entries(s.loops)) {
    if (!live.has(key)) continue
    out[`${key}__mute`]  = row.mute
    out[`${key}__vol`]   = row.vol
    out[`${key}__speed`] = row.speed
  }
  for (const [key, row] of Object.entries(s.events)) {
    if (!live.has(key)) continue
    out[`${key}__mute`]  = row.mute
    out[`${key}__vol`]   = row.vol
    out[`${key}__speed`] = row.speed
  }
  return out
}

export function persistToLocalStorage(v: LevaValues): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(v)))
  } catch { /* quota / private mode — silently noop */ }
}

export function loadFromLocalStorage(): AudioSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && parsed.version === 1) return parsed as AudioSettings
  } catch { /* corrupted — ignore */ }
  return null
}

export function downloadJson(v: LevaValues, filename = 'audio-settings.json'): void {
  const pretty = JSON.stringify(serialize(v), null, 2)
  const blob = new Blob([pretty], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copyToClipboard(v: LevaValues): Promise<void> {
  const pretty = JSON.stringify(serialize(v), null, 2)
  try {
    await navigator.clipboard.writeText(pretty)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audio-settings] clipboard write failed', err)
  }
}

export async function pickAndApply(apply: (flat: LevaValues) => void): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) { resolve(); return }
      try {
        const txt = await f.text()
        const parsed = JSON.parse(txt) as AudioSettings
        if (parsed && parsed.version === 1) apply(flatten(parsed))
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[audio-settings] load failed', err)
      }
      resolve()
    }
    input.click()
  })
}

export function defaultsFlat(): LevaValues {
  const out: LevaValues = {
    masterMute: false, masterVol: 1.0,
    ambientMute: false, ambientVol: 1.0,
    sfxMute: false, sfxVol: 1.0,
    showVisualizer: false,
  }
  for (const def of REGISTRY.loops) {
    out[`${def.key}__mute`]  = false
    out[`${def.key}__vol`]   = 1.0
    out[`${def.key}__speed`] = 1.0
  }
  for (const def of REGISTRY.events) {
    out[`${def.key}__mute`]  = false
    out[`${def.key}__vol`]   = 1.0
    out[`${def.key}__speed`] = 1.0
  }
  return out
}
