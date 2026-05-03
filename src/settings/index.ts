import defaultsJson from './defaults.json'
import { PLANETS, getPlanet } from '../world/planetManifest'

/**
 * Typed handle on `defaults.json`. Every Leva `useControls` default value
 * AND every module-scope uniform initial value pulls from here — so the
 * answer to "what IS the default" is unambiguous. The Copy Settings Leva
 * button serialises live runtime state back into this exact shape.
 *
 * Runtime is still driven by mutable refs / uniform objects; this module
 * only provides the STARTING values.
 *
 * Per-level layering (issue #48): at module init we synchronously fetch
 * `/levels/<slug>/settings.json` and deep-merge it on top of defaults
 * BEFORE any consumer imports `settings` (consumers run AFTER this
 * module's body in ES module ordering). The slug is taken from the URL
 * (`/edit/levels/<slug>/`) or — on the /game/ route — from the
 * persisted progression in localStorage. Without a slug, settings stays
 * at globals.
 */

type RawDefaults = typeof defaultsJson
// `customPath` / `customFilename` are `null` in defaults.json — JSON literal
// inference narrows to the `null` type, but at runtime hdriStore round-trips
// a real path string when a user uploads a custom HDRI. Widen here so capture
// + level-override layers type-check.
export type Settings = Omit<RawDefaults, 'hdri'> & {
  hdri: Omit<RawDefaults['hdri'], 'customPath' | 'customFilename'> & {
    customPath: string | null
    customFilename: string | null
  }
}

function deepClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T }

function deepMergeInto(base: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const key of Object.keys(src)) {
    const sv = src[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      const bv = base[key]
      const target = (bv && typeof bv === 'object' && !Array.isArray(bv))
        ? bv as Record<string, unknown>
        : {}
      deepMergeInto(target, sv as Record<string, unknown>)
      base[key] = target
    } else {
      base[key] = sv
    }
  }
}

/** Resolve the level slug for the current page load — URL takes priority,
 *  else /game/ progression in localStorage, else PLANETS[0] on /game/, else
 *  null (use globals — for /bake/, root /, test routes that have no level). */
function bootResolveSlug(): string | null {
  if (typeof window === 'undefined') return null
  const path = window.location.pathname.toLowerCase()
  const m = path.match(/^\/edit\/levels\/(lvl_\d+)\/?/)
  if (m && getPlanet(m[1])) return m[1]
  if (path.startsWith('/game')) {
    // selectLevel / advancePlanet set rubicsworld:autoStart=1 right before
    // reloading; presence of that flag means the post-reload boot will
    // resume directly at gamePhase='playing'. Use the persisted slug's
    // settings so the level they're about to play has matching HDRI /
    // grass / postfx.
    //
    // Absence means we're landing on the title screen. The title backdrop
    // is forced to lvl_1 by TileGrid (regardless of saved slot) — seed
    // settings from lvl_1 too so the HDRI matches the visible planet.
    // Begin / Select Level both flip to 'playing' via reloadIntoLevel,
    // which sets autoStart=1 → next boot picks up the right slug.
    let autoStart = false
    try { autoStart = localStorage.getItem('rubicsworld:autoStart') === '1' } catch { /* ignore */ }
    if (autoStart) {
      try {
        const raw = localStorage.getItem('rubicsworld:progress')
        if (raw) {
          const p = JSON.parse(raw) as { currentPlanetSlug?: unknown }
          if (typeof p.currentPlanetSlug === 'string' && getPlanet(p.currentPlanetSlug)) {
            return p.currentPlanetSlug
          }
        }
      } catch { /* ignore */ }
    }
    return PLANETS[0]?.slug ?? null
  }
  return null
}

/** Synchronous XHR — yes, deprecated, but it's the only way to seed the
 *  exported `settings` value before downstream module bodies run. Dev-
 *  loop only; no impact on production consumers (the bundle still ships
 *  the global defaults and per-level files served from /public/).
 *
 *  Cache-bust query: the browser's HTTP cache (and any intermediate
 *  proxy) WILL otherwise serve a stale settings.json when the user has
 *  just committed an edit and refreshed — staleness in this path looks
 *  like "the level didn't reload its settings". Forcing a unique URL
 *  per page load sidesteps that without a Cache-Control header on the
 *  static file middleware. */
function bootFetchOverride(slug: string): Record<string, unknown> | null {
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', `/levels/${slug}/settings.json?t=${Date.now()}`, /* async */ false)
    xhr.send()
    if (xhr.status !== 200) return null
    const parsed = JSON.parse(xhr.responseText) as Record<string, unknown>
    return parsed
  } catch {
    return null
  }
}

const merged: Settings = deepClone(defaultsJson)
const _bootSlug = bootResolveSlug()
if (_bootSlug) {
  const override = bootFetchOverride(_bootSlug)
  if (override) deepMergeInto(merged as unknown as Record<string, unknown>, override)
}

export const settings: Settings = merged
/** The slug whose settings.json was layered into `settings` at boot.
 *  Null when the boot URL/localStorage resolved no slug (e.g. /bake/,
 *  root /, test routes). Read by commitSettingsToDisk to target the
 *  same file the consumers were seeded from. */
export const bootLevelSlug: string | null = _bootSlug

/** Captures the current runtime state in the shape of settings.json. Called
 *  by the Copy Settings button. Imports live values lazily (inside the
 *  function) to avoid pulling heavy modules at import time. */
export async function captureLiveSettings(): Promise<Settings> {
  // Per-section try/catch below: if any one block throws (e.g. PostFx not
  // yet mounted, hdriStore not initialised, a uniform field renamed), the
  // commit STILL succeeds for the working sections — broken sections fall
  // back to the JSON defaults instead of taking the whole capture down.
  // Without this, a missing hdriStore.url field used to surface as "click
  // commit, nothing happens, no console error" because the unhandled
  // rejection propagated above the only try/catch (around fetch).

  const { grassUniforms, flowerColorUniforms } = await import('../diorama/buildGrass')
  const { useHdri } = await import('../world/hdriStore')
  const { postfxLive } = await import('../world/PostFx')

  const hex = (c: { getHexString: () => string }) => '#' + c.getHexString()

  // Per-section capture: each block falls back to settings.<section> if
  // anything throws. The fallback is the JSON-defined default, NOT random
  // data — so a partial capture still produces a valid Settings shape.
  const safeSection = <K extends keyof Omit<Settings, '$schema'>>(
    name: K,
    capture: () => Settings[K],
  ): Settings[K] => {
    try { return capture() } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[settings] capture for "${name}" failed; falling back to JSON default:`, err)
      return settings[name]
    }
  }

  return {
    $schema: settings.$schema,
    grass: safeSection('grass', () => ({
      // `visible` / `density` live in Leva alone (not in grassUniforms),
      // so we can only capture from the JSON defaults unless the Leva
      // panel passes its current values in. For now, re-emit whatever
      // the defaults currently hold — Copy Settings button in GrassPanel
      // will merge Leva-side values before serialising.
      visible:        settings.grass.visible,
      density:        settings.grass.density,
      bladeWidth:     settings.grass.bladeWidth,
      bladeHeight:    settings.grass.bladeHeight,
      length:         grassUniforms.uLengthScale.value,
      windSpeed:      grassUniforms.uWindFreq.value,
      windStrength:   grassUniforms.uWindStrength.value,
      bendAmount:     grassUniforms.uBendAmount.value,
      waveScale:      grassUniforms.uWaveScale.value,
      windDirX:       grassUniforms.uWindDir.value.x,
      windDirZ:       grassUniforms.uWindDir.value.y,
      baseColor:      hex(grassUniforms.uBaseColor.value),
      tipColor:       hex(grassUniforms.uTipColor.value),
      stemColor:      hex(grassUniforms.uStemColor.value),
      hueJitter:      grassUniforms.uHueJitter.value,
      hoverRadius:    grassUniforms.uHoverRadius.value,
      hoverStrength:  grassUniforms.uHoverStrength.value,
      trailDecay:     grassUniforms.uTrailDecay.value,
    })),
    flowers: safeSection('flowers', () => ({
      flowerPct:    settings.flowers.flowerPct,
      pinkWeight:   settings.flowers.pinkWeight,
      purpleWeight: settings.flowers.purpleWeight,
      yellowWeight: settings.flowers.yellowWeight,
      redWeight:    settings.flowers.redWeight,
      pinkColor:    hex(flowerColorUniforms.pink.value),
      purpleColor:  hex(flowerColorUniforms.purple.value),
      yellowColor:  hex(flowerColorUniforms.yellow.value),
      redColor:     hex(flowerColorUniforms.red.value),
      flowerWidth:  settings.flowers.flowerWidth,
      flowerHeight: settings.flowers.flowerHeight,
    })),
    hdri: safeSection('hdri', () => {
      const hs = useHdri.getState()
      return {
        preset:            hs.preset,
        blur:              hs.blur,
        intensity:         hs.intensity,
        rotation:          hs.rotation,
        backgroundOpacity: hs.backgroundOpacity,
        physicalLights:    hs.physicalLights,
        uniformColor:      hs.uniformColor,
        envMapIntensity:   hs.envMapIntensity,
        roughnessBoost:    hs.roughnessBoost,
        fresnelEnabled:    hs.fresnelEnabled,
        // Persistent custom HDRI: only round-trip a non-blob URL. Blob
        // URLs die on reload, so committing one would record "loaded
        // HDRI but wrong on next visit" — record null instead, which
        // leaves the next session on the preset until the user re-
        // uploads or /__hdri/commit succeeded and swapped to a public
        // path.
        customPath:     hs.url && !hs.url.startsWith('blob:') ? hs.url : null,
        customFilename: hs.url && !hs.url.startsWith('blob:') ? hs.filename : null,
      }
    }),
    // Snapshot of the PostFx component's live useControls state, mirrored
    // by PostFx.tsx into postfxLive. If PostFx hasn't mounted yet (e.g.
    // capture called pre-canvas) postfxLive still holds the JSON defaults
    // because it's seeded from settings.postfx at module init.
    postfx: safeSection('postfx', () => ({ ...postfxLive })),
    walk: safeSection('walk', () => ({
      playerHeight: settings.walk.playerHeight,
    })),
  }
}

/** Lightweight floating toast — drop-in replacement for the alert()s
 *  scattered through this module. Auto-dismisses after `ms` (default 3 s).
 *  Stacks toasts vertically when multiple fire in succession.
 *
 *  alert() blocks the event loop and pushes the user out of flow; toasts
 *  let them keep adjusting sliders while still seeing what happened. The
 *  three states (success / error / info) map to colour only — the message
 *  carries the verbatim error string when there is one. */
export function toast(kind: 'success' | 'error' | 'info', msg: string, ms = 3000): void {
  if (typeof document === 'undefined') return
  const host = (() => {
    const existing = document.getElementById('settings-toast-host')
    if (existing) return existing
    const el = document.createElement('div')
    el.id = 'settings-toast-host'
    el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;gap:6px;pointer-events:none;'
    document.body.appendChild(el)
    return el
  })()
  const colour = kind === 'success' ? '#3a7a3a' : kind === 'error' ? '#7a3a3a' : '#3a4a7a'
  const div = document.createElement('div')
  div.style.cssText = `background:${colour};color:#f5ead3;padding:8px 14px;border-radius:6px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 2px 12px rgba(0,0,0,0.4);max-width:520px;word-break:break-word;`
  div.textContent = msg
  host.appendChild(div)
  setTimeout(() => {
    div.style.transition = 'opacity 240ms ease'
    div.style.opacity = '0'
    setTimeout(() => div.remove(), 260)
  }, ms)
}

/** Serialises the live settings + copies to clipboard + console.logs. */
export async function copySettingsToClipboard(): Promise<void> {
  let pretty: string
  try {
    const live = await captureLiveSettings()
    pretty = JSON.stringify(live, null, 2)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings] capture failed:', err)
    toast('error', `Capture failed: ${String(err)}`)
    return
  }
  try {
    await navigator.clipboard.writeText(pretty)
    // eslint-disable-next-line no-console
    console.log('[settings] copied to clipboard:\n' + pretty)
    toast('success', 'Settings copied to clipboard')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings] clipboard write failed, logging instead:', err)
    // eslint-disable-next-line no-console
    console.log(pretty)
    toast('info', 'Clipboard blocked — settings logged to console')
  }
}

/** Serialises the live settings + triggers a browser download of
 *  `settings.json`. Drop the downloaded file into `src/settings/` to make it
 *  the new baked-in default (Vite picks up the JSON on next HMR / reload). */
export async function downloadSettingsJson(filename = 'settings.json'): Promise<void> {
  let pretty: string
  try {
    const live = await captureLiveSettings()
    pretty = JSON.stringify(live, null, 2)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings] capture failed:', err)
    toast('error', `Capture failed: ${String(err)}`)
    return
  }
  const blob = new Blob([pretty], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke shortly after the click has been handled — keeps the object URL
  // alive long enough for the browser to actually start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  // eslint-disable-next-line no-console
  console.log('[settings] downloaded ' + filename)
  toast('success', `Downloaded ${filename}`)
}

/** Writes a (partial or full) Settings object into the live runtime state —
 *  grassUniforms / flowerColorUniforms / useHdri. Accepts any subset of the
 *  JSON shape; missing keys are left alone. Does NOT update Leva UI state —
 *  the caller should invoke its `useControls` set() function too so the
 *  sliders visually match. Returns the list of top-level keys that were
 *  touched (for logging / telemetry). */
export async function applySettings(partial: Partial<Settings>): Promise<string[]> {
  const touched: string[] = []
  const [{ grassUniforms, flowerColorUniforms }, { useHdri }] = await Promise.all([
    import('../diorama/buildGrass'),
    import('../world/hdriStore'),
  ])
  const THREE = await import('three')

  if (partial.grass) {
    const g = partial.grass
    touched.push('grass')
    if (g.length        !== undefined) grassUniforms.uLengthScale.value  = g.length
    if (g.windSpeed     !== undefined) grassUniforms.uWindFreq.value     = g.windSpeed
    if (g.windStrength  !== undefined) grassUniforms.uWindStrength.value = g.windStrength
    if (g.bendAmount    !== undefined) grassUniforms.uBendAmount.value   = g.bendAmount
    if (g.waveScale     !== undefined) grassUniforms.uWaveScale.value    = g.waveScale
    if (g.windDirX !== undefined || g.windDirZ !== undefined) {
      grassUniforms.uWindDir.value.set(
        g.windDirX ?? grassUniforms.uWindDir.value.x,
        g.windDirZ ?? grassUniforms.uWindDir.value.y,
      )
    }
    if (g.baseColor     !== undefined) grassUniforms.uBaseColor.value.set(new THREE.Color(g.baseColor))
    if (g.tipColor      !== undefined) grassUniforms.uTipColor.value.set(new THREE.Color(g.tipColor))
    if (g.stemColor     !== undefined) grassUniforms.uStemColor.value.set(new THREE.Color(g.stemColor))
    if (g.hueJitter     !== undefined) grassUniforms.uHueJitter.value    = g.hueJitter
    if (g.hoverRadius   !== undefined) grassUniforms.uHoverRadius.value  = g.hoverRadius
    if (g.hoverStrength !== undefined) grassUniforms.uHoverStrength.value = g.hoverStrength
    if (g.trailDecay    !== undefined) grassUniforms.uTrailDecay.value   = g.trailDecay
  }

  if (partial.flowers) {
    const f = partial.flowers
    touched.push('flowers')
    if (f.pinkColor   !== undefined) flowerColorUniforms.pink.value.set(new THREE.Color(f.pinkColor))
    if (f.purpleColor !== undefined) flowerColorUniforms.purple.value.set(new THREE.Color(f.purpleColor))
    if (f.yellowColor !== undefined) flowerColorUniforms.yellow.value.set(new THREE.Color(f.yellowColor))
    if (f.redColor    !== undefined) flowerColorUniforms.red.value.set(new THREE.Color(f.redColor))
  }

  if (partial.hdri) {
    const h = partial.hdri
    touched.push('hdri')
    const hs = useHdri.getState()
    if (h.preset            !== undefined) hs.setPreset(h.preset as never)
    if (h.blur              !== undefined) hs.setBlur(h.blur)
    if (h.intensity         !== undefined) hs.setIntensity(h.intensity)
    if (h.rotation          !== undefined) hs.setRotation(h.rotation)
    if (h.backgroundOpacity !== undefined) hs.setBackgroundOpacity(h.backgroundOpacity)
    if (h.physicalLights    !== undefined) hs.setPhysicalLights(h.physicalLights)
    if (h.uniformColor      !== undefined) hs.setUniformColor(h.uniformColor)
    if (h.envMapIntensity   !== undefined) hs.setEnvMapIntensity(h.envMapIntensity)
    if (h.roughnessBoost    !== undefined) hs.setRoughnessBoost(h.roughnessBoost)
    if (h.fresnelEnabled    !== undefined) hs.setFresnelEnabled(h.fresnelEnabled)
    // Loading from JSON: if a customPath is provided, hand it to setUrl
    // (filename is just for display). null/undefined customPath means
    // "use the preset" — drop any existing custom URL.
    if (h.customPath !== undefined) hs.setUrl(h.customPath, h.customFilename ?? null)
  }

  if (partial.postfx) {
    touched.push('postfx')
    // Mirror is the read-side source of truth for capture; write it
    // immediately so a follow-up capture is consistent. The Leva-side push
    // (via flattenSettingsForLeva → setLeva) drives the actual scene
    // because the useEffect chain in PostFx.tsx fires on Leva-state changes.
    const { postfxLive } = await import('../world/PostFx')
    Object.assign(postfxLive, partial.postfx)
  }

  // eslint-disable-next-line no-console
  console.log('[settings] applied:', touched)
  return touched
}

/** Flattens a Settings object to the FLAT key-space Leva's set() wants.
 *
 *  Leva internals (leva.esm.js:2260) look up keys in `mappedPaths` which is
 *  keyed by the DECLARATION key (e.g. `length`), not the folder path
 *  (`Grass.length`). Passing a namespaced key hits
 *    `TypeError: can't access property "path", mappedPaths[p] is undefined`
 *  because only the bare declaration name is registered.
 *
 *  Exclusions — settings keys that don't exist as Leva controls:
 *   - grass.bladeWidth / bladeHeight (build-time only)
 *   - flowers.flowerWidth / flowerHeight (build-time only)
 *  Passing these would trigger the same mappedPaths error. The uniform /
 *  geometry side of applySettings handles them separately. */
export function flattenSettingsForLeva(s: Partial<Settings>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const grassSkip = new Set(['bladeWidth', 'bladeHeight'])
  const flowersSkip = new Set(['flowerWidth', 'flowerHeight'])
  if (s.grass) {
    for (const [k, v] of Object.entries(s.grass)) {
      if (grassSkip.has(k)) continue
      out[k] = v
    }
  }
  if (s.flowers) {
    for (const [k, v] of Object.entries(s.flowers)) {
      if (flowersSkip.has(k)) continue
      out[k] = v
    }
  }
  // PostFx values live in PostFx.tsx's useControls — every key in
  // settings.postfx.X is registered as a bare declaration name (folder paths
  // don't enter mappedPaths), so we can pass them through unchanged.
  if (s.postfx) {
    for (const [k, v] of Object.entries(s.postfx)) {
      out[k] = v
    }
  }
  // HDRI values live in the HTML panel (not Leva), so they're not included.
  return out
}

/** Commit the current live settings to disk at
 *  `public/levels/<slug>/settings.json` via the Vite dev-server middleware
 *  at POST /__settings/commit?level=<slug>. Dev-only — there's no
 *  equivalent in production (and production doesn't need writable
 *  settings). HMR picks up the file change; on the next page load this
 *  module's boot-time sync layer reads the level's settings.json and
 *  consumers see the committed values.
 *
 *  The slug is whichever level was layered into `settings` at boot —
 *  ensures Commit writes to the same file the live consumers were
 *  seeded from, so a session is internally consistent. Errors out when
 *  there's no boot slug (root /, /bake/, etc.) — committing to "global
 *  defaults" was the source of the cross-level pollution bug; we don't
 *  silently fall back to it. */
export async function commitSettingsToDisk(): Promise<void> {
  if (!bootLevelSlug) {
    // eslint-disable-next-line no-console
    console.error('[settings] no boot level slug — open /edit/levels/<slug>/ or /game/ to commit')
    toast('error', 'No active level — open /edit/levels/<slug>/ first')
    return
  }
  let pretty: string
  try {
    const live = await captureLiveSettings()
    pretty = JSON.stringify(live, null, 2)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings] capture failed:', err)
    toast('error', `Capture failed: ${String(err)}`)
    return
  }
  try {
    const res = await fetch(`/__settings/commit?level=${encodeURIComponent(bootLevelSlug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: pretty,
    })
    const payload = await res.json().catch(() => ({ ok: false, error: 'non-JSON response' }))
    if (!res.ok || !payload.ok) {
      // eslint-disable-next-line no-console
      console.error('[settings] commit failed:', payload)
      toast('error', `Commit failed: ${payload.error ?? 'unknown'} (only works in npm run dev)`)
      return
    }
    // eslint-disable-next-line no-console
    console.log('[settings] committed to', payload.path)
    toast('success', `Committed to ${payload.path}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings] commit error:', err)
    toast('error', `Commit error: ${String(err)} (only works in npm run dev)`)
  }
}

/** Open a file picker, read JSON, apply. `onAfterApply` lets the caller sync
 *  its Leva useControls state via set(). */
export async function pickAndApplySettings(
  onAfterApply?: (flatLevaValues: Record<string, unknown>) => void,
): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Partial<Settings>
      await applySettings(parsed)
      onAfterApply?.(flattenSettingsForLeva(parsed))
      toast('success', `Applied ${file.name}`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[settings] apply failed:', err)
      toast('error', `Apply failed: ${String(err)}`)
    }
  }
  input.click()
}
