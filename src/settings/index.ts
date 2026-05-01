import defaultsJson from './defaults.json'

/**
 * Typed handle on `defaults.json`. Every Leva `useControls` default value
 * AND every module-scope uniform initial value pulls from here — so the
 * answer to "what IS the default" is unambiguous. The Copy Settings Leva
 * button serialises live runtime state back into this exact shape.
 *
 * Runtime is still driven by mutable refs / uniform objects; this module
 * only provides the STARTING values.
 */

export type Settings = typeof defaultsJson

export const settings: Settings = defaultsJson

/** Captures the current runtime state in the shape of settings.json. Called
 *  by the Copy Settings button. Imports live values lazily (inside the
 *  function) to avoid pulling heavy modules at import time. */
export async function captureLiveSettings(): Promise<Settings> {
  const { grassUniforms, flowerColorUniforms } = await import('../diorama/buildGrass')
  const { useHdri } = await import('../world/hdriStore')
  const { postfxLive } = await import('../world/PostFx')

  const hex = (c: { getHexString: () => string }) => '#' + c.getHexString()

  const hs = useHdri.getState()

  return {
    $schema: settings.$schema,
    grass: {
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
    },
    flowers: {
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
    },
    hdri: {
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
    },
    // Snapshot of the PostFx component's live useControls state, mirrored
    // by PostFx.tsx into postfxLive. If PostFx hasn't mounted yet (e.g.
    // capture called pre-canvas) postfxLive still holds the JSON defaults
    // because it's seeded from settings.postfx at module init.
    postfx: { ...postfxLive },
  }
}

/** Serialises the live settings + copies to clipboard + console.logs. */
export async function copySettingsToClipboard(): Promise<void> {
  const live = await captureLiveSettings()
  const pretty = JSON.stringify(live, null, 2)
  try {
    await navigator.clipboard.writeText(pretty)
    // eslint-disable-next-line no-console
    console.log('[settings] copied to clipboard:\n' + pretty)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings] clipboard write failed, logging instead:', err)
    // eslint-disable-next-line no-console
    console.log(pretty)
  }
}

/** Serialises the live settings + triggers a browser download of
 *  `settings.json`. Drop the downloaded file into `src/settings/` to make it
 *  the new baked-in default (Vite picks up the JSON on next HMR / reload). */
export async function downloadSettingsJson(filename = 'settings.json'): Promise<void> {
  const live = await captureLiveSettings()
  const pretty = JSON.stringify(live, null, 2)
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

/** Commit the current live settings to disk at `src/settings/defaults.json`
 *  via the Vite dev-server middleware at POST /__settings/commit. Dev-only —
 *  there's no equivalent in production (and production doesn't need
 *  writable settings). HMR picks up the file change and the app re-evaluates
 *  module-scope uniforms with the new defaults on the next reload. */
export async function commitSettingsToDisk(): Promise<void> {
  const live = await captureLiveSettings()
  const pretty = JSON.stringify(live, null, 2)
  try {
    const res = await fetch('/__settings/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: pretty,
    })
    const payload = await res.json().catch(() => ({ ok: false, error: 'non-JSON response' }))
    if (!res.ok || !payload.ok) {
      // eslint-disable-next-line no-console
      console.error('[settings] commit failed:', payload)
      alert('Commit failed — see console. (Only works in `npm run dev`.)')
      return
    }
    // eslint-disable-next-line no-console
    console.log('[settings] committed to', payload.path)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings] commit error:', err)
    alert('Commit error — see console. (Only works in `npm run dev`.)')
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
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[settings] apply failed:', err)
      alert('Failed to apply settings — see console.')
    }
  }
  input.click()
}
