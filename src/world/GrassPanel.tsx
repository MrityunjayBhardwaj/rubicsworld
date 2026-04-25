/**
 * Leva panel for grass uniforms + visible-count scaling + density-map debug
 * overlay.
 *
 * Writes directly into the module-scoped grassUniforms exported by
 * buildGrass — same pattern as fresnelUniform / sliceRotUniforms. Density
 * scales mesh.count so the slider is free (no geometry rebuild).
 *
 * The density-map overlay renders the 8×6 flat cross-net top-down, with
 * face-block outlines, prop exclusion rects (per-prop colour), and
 * surviving blade roots as dots. Useful for verifying that road/pond/etc
 * exclusion is actually covering the authored prop footprint.
 */
import { useControls, folder, button } from 'leva'
import { useCallback, useEffect, useRef } from 'react'
import * as THREE from 'three'
import { flowerColorUniforms, FLOWER_KEYS, grassDebug, grassRefs, grassUniforms, type FlowerKey } from '../diorama/buildGrass'
import { settings, copySettingsToClipboard, downloadSettingsJson, pickAndApplySettings, commitSettingsToDisk } from '../settings'
import { setWalkMask, walkMaskRefs, DEFAULT_WALK_MASK_URL } from './walkMask'

function triggerDownload(dataUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}


/** Render a clean black-and-white mask of the density map: white = allowed,
 *  black = out-of-bounds or inside a prop exclusion. Same coordinate space as
 *  the overlay canvas, no chrome — this is the file you edit in an image
 *  editor and (future) feed back as a texture for custom exclusion shapes. */
function renderMaskCanvas(w: number, h: number): HTMLCanvasElement | null {
  const data = grassDebug.data
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!data || !ctx) return null
  const domW = data.halfW * 2
  const domH = data.halfH * 2
  const scale = Math.min(w / domW, h / domH)
  const cx = w / 2
  const cy = h / 2
  const toPxX = (x: number) => cx + x * scale
  const toPxY = (z: number) => cy + z * scale
  // Everything black by default (out-of-bounds = no grass).
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  // Allowed ground rect(s) → white.
  ctx.fillStyle = '#fff'
  for (const b of data.blocks) {
    ctx.fillRect(
      toPxX(b.cx - b.halfX),
      toPxY(b.cz - b.halfZ),
      b.halfX * 2 * scale,
      b.halfZ * 2 * scale,
    )
  }
  // Prop exclusions → black.
  ctx.fillStyle = '#000'
  for (const e of data.exclusions) {
    ctx.fillRect(
      toPxX(e.xMin),
      toPxY(e.zMin),
      (e.xMax - e.xMin) * scale,
      (e.zMax - e.zMin) * scale,
    )
  }
  return c
}

export function GrassPanel() {
  // useControls returns [values, set] when the first arg is a function —
  // set() lets us push the applied JSON into Leva's UI state so sliders
  // visually match what we wrote to the uniforms.
  //
  // The schema function is wrapped in useCallback so its identity is stable
  // across renders. Without the wrap, every App re-render (cameraMode,
  // preview toggle, HDRI preset change cascade, etc.) passes a FRESH
  // function to useControls, which Leva's internal useMemo treats as a new
  // schema → re-seeds initialData → visually "resets" sliders to
  // defaults. Stable fn identity means Leva only builds the schema once.
  const grassSchema = useCallback(() => ({
    Project: folder(
      {
        // Copy the current live settings (grass + flowers + HDRI) to the
        // clipboard as JSON in the exact shape of settings/defaults.json.
        copySettings: button(() => { void copySettingsToClipboard() }),
        // Download the current live settings as `settings.json` — drop the
        // file into src/settings/ to hand-commit the new default.
        saveSettings: button(() => { void downloadSettingsJson() }),
        // File picker → load settings.json → write into live uniforms +
        // HDRI store, then push the Leva-side keys back through setLeva()
        // so the sliders match what we applied. Values NOT present in the
        // loaded JSON are left at their current live state. Per-key try/
        // catch guards against keys in the JSON that aren't registered as
        // Leva controls — Leva's set() crashes the whole batch on a single
        // unknown key (mappedPaths[p] is undefined); per-key isolation
        // skips only the unknowns and applies the rest.
        uploadSettings: button(() => {
          void pickAndApplySettings(flat => {
            for (const [k, v] of Object.entries(flat)) {
              try {
                setLeva({ [k]: v })
              } catch {
                // eslint-disable-next-line no-console
                console.warn('[settings] unknown Leva key skipped:', k)
              }
            }
          })
        }),
        // Dev-server-only: POSTs the live settings to Vite's middleware
        // which writes src/settings/defaults.json directly. HMR then
        // re-evaluates the module and the new values become the baked-in
        // defaults on next reload. One-click alternative to Save → drop-
        // into-folder.
        commitSettings: button(() => { void commitSettingsToDisk() }),
      },
      { collapsed: false },
    ),
    Grass: folder(
      {
        visible:       { value: settings.grass.visible },
        density:       { value: settings.grass.density, min: 0, max: 50, step: 0.1, label: 'density' },
        length:        { value: grassUniforms.uLengthScale.value,  min: 0.1, max: 6, step: 0.01, label: 'length' },
        windSpeed:     { value: grassUniforms.uWindFreq.value,     min: 0, max: 6, step: 0.01, label: 'wind speed' },
        windStrength:  { value: grassUniforms.uWindStrength.value, min: 0, max: 4, step: 0.01, label: 'wind strength' },
        bendAmount:    { value: grassUniforms.uBendAmount.value,   min: 0, max: 1.2, step: 0.005, label: 'bend (rad)' },
        waveScale:     { value: grassUniforms.uWaveScale.value,    min: 0, max: 12, step: 0.05, label: 'wave scale (spatial)' },
        windDirX:      { value: grassUniforms.uWindDir.value.x,    min: -1, max: 1, step: 0.01, label: 'wind dir x' },
        windDirZ:      { value: grassUniforms.uWindDir.value.y,    min: -1, max: 1, step: 0.01, label: 'wind dir z' },
        baseColor:     { value: '#' + grassUniforms.uBaseColor.value.getHexString(), label: 'base colour' },
        tipColor:      { value: '#' + grassUniforms.uTipColor.value.getHexString(),  label: 'tip colour' },
        stemColor:     { value: '#' + grassUniforms.uStemColor.value.getHexString(), label: 'flower stem colour' },
        hueJitter:     { value: grassUniforms.uHueJitter.value, min: 0, max: 0.5, step: 0.01, label: 'hue jitter' },
        hoverRadius:   { value: grassUniforms.uHoverRadius.value,   min: 0.02, max: 0.8, step: 0.005, label: 'hover radius (m)' },
        hoverStrength: { value: grassUniforms.uHoverStrength.value, min: 0,    max: 3,   step: 0.01,  label: 'hover strength' },
        trailDecay:    { value: grassUniforms.uTrailDecay.value,    min: 0.1,  max: 4,   step: 0.05,  label: 'trail decay (s)' },
        densityMap:    { value: false, label: 'show density map' },
        saveDensityMap: button(() => saveOverlayPng()),
        saveMask:       button(() => saveMaskPng()),
        saveCubenet:    button(() => { void saveCubenetPng() }),
        loadMask:       button(() => { void loadMaskPng() }),
        clearMask:      button(() => { grassRefs.rebuildWithMask?.(null) }),
        saveDioramaGlb:   button(() => { void saveDioramaGlb() }),
        commitDioramaGlb: button(() => { void commitDioramaGlbToDisk() }),
      },
      { collapsed: true },
    ),
    Flowers: folder(
      {
        flowerPct:    { value: settings.flowers.flowerPct,    min: 0, max: 100, step: 0.5, label: 'flower % (vs grass)' },
        pinkWeight:   { value: settings.flowers.pinkWeight,   min: 0, max: 1, step: 0.01, label: 'pink ratio' },
        purpleWeight: { value: settings.flowers.purpleWeight, min: 0, max: 1, step: 0.01, label: 'purple ratio' },
        yellowWeight: { value: settings.flowers.yellowWeight, min: 0, max: 1, step: 0.01, label: 'yellow ratio' },
        redWeight:    { value: settings.flowers.redWeight,    min: 0, max: 1, step: 0.01, label: 'red ratio' },
        pinkColor:    { value: '#' + flowerColorUniforms.pink.value.getHexString(),   label: 'pink' },
        purpleColor:  { value: '#' + flowerColorUniforms.purple.value.getHexString(), label: 'purple' },
        yellowColor:  { value: '#' + flowerColorUniforms.yellow.value.getHexString(), label: 'yellow' },
        redColor:     { value: '#' + flowerColorUniforms.red.value.getHexString(),    label: 'red' },
        // Flower-specific distribution mask (white=allow, black=exclude). Shares
        // the 8×6 flat-net coord frame with the grass mask but gates ONLY the
        // 4 flower buckets — so you can blanket-allow grass everywhere and
        // constrain flowers to specific regions (or vice versa).
        loadFlowerMask:   button(() => { void loadFlowerMaskPng() }),
        clearFlowerMask:  button(() => { grassRefs.rebuildWithFlowerMask?.(null) }),
        saveFlowerMask:   button(() => { void saveFlowerMaskPng() }),
        commitFlowerMask: button(() => { void commitFlowerMaskToDisk() }),
      },
      { collapsed: true },
    ),
    Walk: folder(
      {
        // Player no-go mask. White = walkable, black = blocked. Same flat-net
        // 8×6 frame as the grass / flower masks — start from grass-mask.png
        // (most no-grass zones are also no-walk zones) and tweak.
        loadWalkMask:   button(() => { void loadWalkMaskPng() }),
        clearWalkMask:  button(() => { setWalkMask(null) }),
        saveWalkMask:   button(() => { void saveWalkMaskPng() }),
        commitWalkMask: button(() => { void commitWalkMaskToDisk() }),
      },
      { collapsed: true },
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])
  const [controls, setLeva] = useControls(grassSchema)

  useEffect(() => {
    grassUniforms.uWindStrength.value = controls.windStrength
    grassUniforms.uWindFreq.value     = controls.windSpeed
    grassUniforms.uWaveScale.value    = controls.waveScale
    grassUniforms.uBendAmount.value   = controls.bendAmount
    grassUniforms.uLengthScale.value  = controls.length
    grassUniforms.uWindDir.value.set(controls.windDirX, controls.windDirZ)
    grassUniforms.uHueJitter.value    = controls.hueJitter
    grassUniforms.uHoverRadius.value   = controls.hoverRadius
    grassUniforms.uHoverStrength.value = controls.hoverStrength
    grassUniforms.uTrailDecay.value    = controls.trailDecay
    grassUniforms.uBaseColor.value.set(new THREE.Color(controls.baseColor))
    grassUniforms.uTipColor.value.set(new THREE.Color(controls.tipColor))
    grassUniforms.uStemColor.value.set(new THREE.Color(controls.stemColor))
    flowerColorUniforms.pink.value.set(new THREE.Color(controls.pinkColor))
    flowerColorUniforms.purple.value.set(new THREE.Color(controls.purpleColor))
    flowerColorUniforms.yellow.value.set(new THREE.Color(controls.yellowColor))
    flowerColorUniforms.red.value.set(new THREE.Color(controls.redColor))
  }, [
    controls.windStrength, controls.windSpeed, controls.waveScale,
    controls.bendAmount, controls.length,
    controls.windDirX, controls.windDirZ,
    controls.hueJitter, controls.baseColor, controls.tipColor, controls.stemColor,
    controls.pinkColor, controls.purpleColor, controls.yellowColor, controls.redColor,
  ])

  // Per-bucket visible-count control. The meadow contains ONE grass mesh +
  // FOUR flower meshes, each pre-built at roughly 1/5 of total survivors.
  //   totalVisible = maxGrass × (density / 50)
  //   flowerShare  = totalVisible × flowerPct / 100
  //   grassCount   = totalVisible − flowerShare (clamped to grass max)
  //   per-colour   = flowerShare × weight / sumWeights (clamped per-colour)
  // maxGrass is treated as the ballpark "total slots visible" since each of
  // Load the bundled default density mask on first mount. Waits for
  // grassRefs.rebuildWithMask to be published by TileGrid, then rasterizes
  // /grass-mask.png and applies it. Idempotent via module-scoped guard so
  // HMR remounts of this panel don't re-trigger a second rebuild.
  useEffect(() => { void applyDefaultGrassMask() }, [])

  // Same pattern for the flower-only mask. Independent ref guard so the two
  // default loaders don't race each other's state.
  useEffect(() => { void applyDefaultFlowerMask() }, [])

  // Walk mask is consumed by WalkControls (not by buildGrass), so it doesn't
  // need to wait for grassRefs hooks — just rasterize and stash.
  useEffect(() => { void applyDefaultWalkMask() }, [])

  // the 5 buckets is allocated ≈ the same capacity — simpler than juggling a
  // composite number and stays consistent with the density=0..50 UX.
  useEffect(() => {
    const refs = grassRefs
    if (!refs.mesh) return
    refs.mesh.visible = controls.visible
    for (const m of refs.meadowMeshes) m.visible = controls.visible

    const totalVisible = Math.floor(refs.maxCount * (controls.density / 50))
    const flowerFrac = controls.flowerPct / 100
    const flowerShare = Math.floor(totalVisible * flowerFrac)
    const grassCount = Math.max(0, Math.min(refs.maxCount, totalVisible - flowerShare))
    refs.mesh.count = grassCount

    const weights: Record<FlowerKey, number> = {
      pink:   controls.pinkWeight,
      purple: controls.purpleWeight,
      yellow: controls.yellowWeight,
      red:    controls.redWeight,
    }
    const sumW = Math.max(1e-6, weights.pink + weights.purple + weights.yellow + weights.red)
    for (const key of FLOWER_KEYS) {
      const desired = Math.floor(flowerShare * (weights[key] / sumW))
      const mesh = refs.meadowMeshes.find(m => m.name === `flower-${key}`)
      if (!mesh) continue
      mesh.count = Math.max(0, Math.min(refs.meadowMax[key], desired))
    }
  }, [
    controls.visible, controls.density, controls.flowerPct,
    controls.pinkWeight, controls.purpleWeight, controls.yellowWeight, controls.redWeight,
  ])

  // Hot-reload replay hook. On ?glb=1 scene swaps, buildGrass creates fresh
  // meshes with default mesh.count = 50% of max — that wipes whatever the
  // user had dialled in. Register a callback TileGrid calls after swap-in
  // that re-applies every current slider / colour to the new uniforms +
  // meshes. Controls closed over via a ref so the latest values are always
  // read (no stale closure).
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  useEffect(() => {
    grassRefs.reapplyControls = () => {
      const c = controlsRef.current
      grassUniforms.uWindStrength.value = c.windStrength
      grassUniforms.uWindFreq.value     = c.windSpeed
      grassUniforms.uWaveScale.value    = c.waveScale
      grassUniforms.uBendAmount.value   = c.bendAmount
      grassUniforms.uLengthScale.value  = c.length
      grassUniforms.uWindDir.value.set(c.windDirX, c.windDirZ)
      grassUniforms.uHueJitter.value    = c.hueJitter
      grassUniforms.uBaseColor.value.set(new THREE.Color(c.baseColor))
      grassUniforms.uTipColor.value.set(new THREE.Color(c.tipColor))
      grassUniforms.uStemColor.value.set(new THREE.Color(c.stemColor))
      flowerColorUniforms.pink.value.set(new THREE.Color(c.pinkColor))
      flowerColorUniforms.purple.value.set(new THREE.Color(c.purpleColor))
      flowerColorUniforms.yellow.value.set(new THREE.Color(c.yellowColor))
      flowerColorUniforms.red.value.set(new THREE.Color(c.redColor))

      const refs = grassRefs
      if (!refs.mesh) return
      refs.mesh.visible = c.visible
      for (const m of refs.meadowMeshes) m.visible = c.visible
      const totalVisible = Math.floor(refs.maxCount * (c.density / 50))
      const flowerShare = Math.floor(totalVisible * (c.flowerPct / 100))
      refs.mesh.count = Math.max(0, Math.min(refs.maxCount, totalVisible - flowerShare))
      const weights: Record<FlowerKey, number> = {
        pink: c.pinkWeight, purple: c.purpleWeight,
        yellow: c.yellowWeight, red: c.redWeight,
      }
      const sumW = Math.max(1e-6, weights.pink + weights.purple + weights.yellow + weights.red)
      for (const key of FLOWER_KEYS) {
        const desired = Math.floor(flowerShare * (weights[key] / sumW))
        const mesh = refs.meadowMeshes.find(m => m.name === `flower-${key}`)
        if (!mesh) continue
        mesh.count = Math.max(0, Math.min(refs.meadowMax[key], desired))
      }
    }
    return () => { grassRefs.reapplyControls = null }
  }, [])

  return controls.densityMap ? <DensityMapOverlay /> : null
}

/** Downloads three PNGs:
 *    - grass-density-map.png : the labelled overlay canvas (reference).
 *    - grass-mask.png        : clean B/W mask in the same coordinate frame
 *                              (white = allowed, black = exclude). Paint this.
 *    - grass-cubenet.png     : top-down orthographic render of the actual
 *                              unpatched diorama (reference while painting). */
// Three separate save actions — one download per user gesture. Browsers
// reliably block multi-file download bursts from one click; each button
// corresponds to one PNG to keep the gesture context intact.

function tstamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function saveOverlayPng() {
  const overlay = renderOverlayCanvas(1200, 900)
  if (!overlay) return
  triggerDownload(overlay.toDataURL('image/png'), `grass-density-map_${tstamp()}.png`)
}

function saveMaskPng() {
  const mask = renderMaskCanvas(1200, 900)
  if (!mask) return
  triggerDownload(mask.toDataURL('image/png'), `grass-mask_${tstamp()}.png`)
}

async function saveCubenetPng() {
  if (!grassRefs.captureTopView) return
  const blob = await grassRefs.captureTopView()
  if (!blob) return
  // Blob URLs handle the ~800 KB rendered PNG reliably; base64 data URLs at
  // that size occasionally fail to trigger the download in Chromium.
  const url = URL.createObjectURL(blob)
  triggerDownload(url, `grass-cubenet_${tstamp()}.png`)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** Opens a file picker, reads the selected PNG/JPG into an ImageData, and
 *  asks TileGrid to rebuild the grass with that mask as the authoritative
 *  exclusion map. Any resolution / aspect is accepted — the sampler maps
 *  the mask's full width/height onto the 8×6 flat-net frame. White pixels
 *  (luminance > threshold) allow grass; black/grey pixels exclude. */
/** Downloads the flat cube-net as a .glb Blender can open. The export path
 *  runs a clean throwaway buildDiorama (no meadow, no shader patches) so the
 *  file stays lean and opens in Blender with identity transforms. */
async function saveDioramaGlb() {
  if (!grassRefs.saveDiorama) return
  const blob = await grassRefs.saveDiorama()
  if (!blob) return
  const url = URL.createObjectURL(blob)
  triggerDownload(url, `diorama-base_${tstamp()}.glb`)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** Bake the imperative diorama (props + colliders + 4-second procedural
 *  animation loop) and overwrite public/diorama.glb on disk via the
 *  /__diorama/commit-glb middleware. After this, hitting the app with
 *  ?glb=1 loads an exact copy of the imperative scene; importing the
 *  glb in Blender drops props into rubics_diorama and collider cubes
 *  into rubics_collider via the Import operator's role-sorting. */
async function commitDioramaGlbToDisk() {
  if (!grassRefs.saveDiorama) {
    alert('Diorama bake not ready yet — try again in a moment.')
    return
  }
  const blob = await grassRefs.saveDiorama()
  if (!blob) {
    alert('Diorama bake failed — see console.')
    return
  }
  try {
    const res = await fetch('/__diorama/commit-glb', {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary' },
      body: blob,
    })
    const payload = await res.json().catch(() => ({ ok: false, error: 'non-JSON response' }))
    if (!res.ok || !payload.ok) {
      // eslint-disable-next-line no-console
      console.error('[diorama] commit failed:', payload)
      alert('diorama.glb commit failed — see console. (Only works in `npm run dev`.)')
      return
    }
    // eslint-disable-next-line no-console
    console.log(`[diorama] committed ${payload.size} bytes to ${payload.path}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[diorama] commit error:', err)
    alert('diorama.glb commit error — see console.')
  }
}

async function rasterizePngToImageData(url: string): Promise<ImageData | null> {
  const img = await new Promise<HTMLImageElement | null>(resolve => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => resolve(i)
    i.onerror = () => resolve(null)
    i.src = url
  })
  if (!img) return null
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, img.width, img.height)
}

async function loadMaskPng() {
  if (!grassRefs.rebuildWithMask) return
  const file = await new Promise<File | null>(resolve => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/png, image/jpeg, image/webp'
    inp.onchange = () => resolve(inp.files?.[0] ?? null)
    inp.click()
  })
  if (!file) return
  const blobUrl = URL.createObjectURL(file)
  const data = await rasterizePngToImageData(blobUrl)
  URL.revokeObjectURL(blobUrl)
  if (data) grassRefs.rebuildWithMask(data)
}

/** URL of the bundled default density mask. Lives in /public so Vite serves
 *  it at the site root — no `?url` import gymnastics, works identically in
 *  dev + prod builds. Overwritten via the Grass panel's Upload/Load mask
 *  button at runtime (which calls rebuildWithMask with a user-picked PNG). */
export const DEFAULT_GRASS_MASK_URL = '/grass-mask.png'
/** Same as above but for the flower-only distribution mask. Bundled 1×1 white
 *  by default (no gating) — Commit Flower Mask overwrites with the current
 *  live mask on disk via vite.config.ts's /__mask/commit/flower middleware. */
export const DEFAULT_FLOWER_MASK_URL = '/flower-mask.png'

/** Re-encode an ImageData back to a PNG Blob via a canvas round-trip. Used by
 *  Save/Commit Flower Mask so the in-memory mask (which may have been rasterized
 *  from any file the user picked) is persisted as a valid PNG. */
function imageDataToPngBlob(data: ImageData): Promise<Blob | null> {
  const c = document.createElement('canvas')
  c.width = data.width
  c.height = data.height
  const ctx = c.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.putImageData(data, 0, 0)
  return new Promise(resolve => c.toBlob(b => resolve(b), 'image/png'))
}

async function loadFlowerMaskPng() {
  if (!grassRefs.rebuildWithFlowerMask) return
  const file = await new Promise<File | null>(resolve => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/png, image/jpeg, image/webp'
    inp.onchange = () => resolve(inp.files?.[0] ?? null)
    inp.click()
  })
  if (!file) return
  const blobUrl = URL.createObjectURL(file)
  const data = await rasterizePngToImageData(blobUrl)
  URL.revokeObjectURL(blobUrl)
  if (data) grassRefs.rebuildWithFlowerMask(data)
}

async function saveFlowerMaskPng() {
  const mask = grassRefs.activeFlowerMask
  if (!mask) {
    // eslint-disable-next-line no-console
    console.warn('[flower-mask] no active flower mask — upload one first')
    return
  }
  const blob = await imageDataToPngBlob(mask)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  triggerDownload(url, `flower-mask_${tstamp()}.png`)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** Dev-only: POST the current flower mask to vite's /__mask/commit/flower
 *  middleware, which writes it to public/flower-mask.png on disk. Page reload
 *  then picks up the bundled default. One-click alternative to Save →
 *  drop-into-public/. */
async function commitFlowerMaskToDisk() {
  const mask = grassRefs.activeFlowerMask
  if (!mask) {
    // eslint-disable-next-line no-console
    console.warn('[flower-mask] no active flower mask — upload one first')
    alert('Upload a flower mask first, then commit.')
    return
  }
  const blob = await imageDataToPngBlob(mask)
  if (!blob) return
  try {
    const res = await fetch('/__mask/commit/flower', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    })
    const payload = await res.json().catch(() => ({ ok: false, error: 'non-JSON response' }))
    if (!res.ok || !payload.ok) {
      // eslint-disable-next-line no-console
      console.error('[flower-mask] commit failed:', payload)
      alert('Flower-mask commit failed — see console. (Only works in `npm run dev`.)')
      return
    }
    // eslint-disable-next-line no-console
    console.log('[flower-mask] committed to', payload.path)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[flower-mask] commit error:', err)
    alert('Flower-mask commit error — see console. (Only works in `npm run dev`.)')
  }
}

async function loadWalkMaskPng() {
  const file = await new Promise<File | null>(resolve => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/png, image/jpeg, image/webp'
    inp.onchange = () => resolve(inp.files?.[0] ?? null)
    inp.click()
  })
  if (!file) return
  const blobUrl = URL.createObjectURL(file)
  const data = await rasterizePngToImageData(blobUrl)
  URL.revokeObjectURL(blobUrl)
  if (data) setWalkMask(data)
}

async function saveWalkMaskPng() {
  const mask = walkMaskRefs.data
  if (!mask) {
    // eslint-disable-next-line no-console
    console.warn('[walk-mask] no active walk mask — upload one first')
    return
  }
  const blob = await imageDataToPngBlob(mask)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  triggerDownload(url, `walk-mask_${tstamp()}.png`)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

async function commitWalkMaskToDisk() {
  const mask = walkMaskRefs.data
  if (!mask) {
    // eslint-disable-next-line no-console
    console.warn('[walk-mask] no active walk mask — upload one first')
    alert('Upload a walk mask first, then commit.')
    return
  }
  const blob = await imageDataToPngBlob(mask)
  if (!blob) return
  try {
    const res = await fetch('/__mask/commit/walk', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    })
    const payload = await res.json().catch(() => ({ ok: false, error: 'non-JSON response' }))
    if (!res.ok || !payload.ok) {
      // eslint-disable-next-line no-console
      console.error('[walk-mask] commit failed:', payload)
      alert('Walk-mask commit failed — see console. (Only works in `npm run dev`.)')
      return
    }
    // eslint-disable-next-line no-console
    console.log('[walk-mask] committed to', payload.path)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[walk-mask] commit error:', err)
    alert('Walk-mask commit error — see console. (Only works in `npm run dev`.)')
  }
}

let defaultWalkMaskApplied = false
async function applyDefaultWalkMask() {
  if (defaultWalkMaskApplied) return
  defaultWalkMaskApplied = true
  if (walkMaskRefs.data) return  // user already uploaded
  // Two-tier default: explicit walk-mask first, grass-mask as fallback.
  // The grass exclusion painting (pond / road / hut footprint) usually
  // matches what should also block walking — saves the author from
  // painting a duplicate file. Override with Upload Walk Mask in the
  // panel, then Commit, to break the link.
  let data = await rasterizePngToImageData(DEFAULT_WALK_MASK_URL)
  if (!data) {
    data = await rasterizePngToImageData(DEFAULT_GRASS_MASK_URL)
    if (data) {
      // eslint-disable-next-line no-console
      console.log('[walk-mask] no /walk-mask.png — falling back to /grass-mask.png')
    }
  }
  if (data && !walkMaskRefs.data) setWalkMask(data)
}

let defaultFlowerMaskApplied = false
async function applyDefaultFlowerMask() {
  if (defaultFlowerMaskApplied) return
  for (let i = 0; i < 60 && !grassRefs.rebuildWithFlowerMask; i++) {
    await new Promise(r => setTimeout(r, 50))
  }
  if (!grassRefs.rebuildWithFlowerMask) {
    // eslint-disable-next-line no-console
    console.warn('[flower-mask] rebuildWithFlowerMask not available after 3s — skipping default mask')
    return
  }
  if (grassRefs.activeFlowerMask) {
    defaultFlowerMaskApplied = true
    return
  }
  const data = await rasterizePngToImageData(DEFAULT_FLOWER_MASK_URL)
  if (!data) {
    // The bundled default is optional — a 404 here (file not on disk yet) is
    // fine; flowers simply fall back to the grass mask / AABB gate. Don't
    // warn so the first-ever session doesn't spam the console.
    defaultFlowerMaskApplied = true
    return
  }
  if (grassRefs.activeFlowerMask) {
    defaultFlowerMaskApplied = true
    return
  }
  grassRefs.rebuildWithFlowerMask(data)
  defaultFlowerMaskApplied = true
}

/** Apply the bundled default density mask to the grass system as soon as
 *  `grassRefs.rebuildWithMask` becomes available. grassRefs is populated by
 *  TileGrid after the first build — order-of-mount can put GrassPanel
 *  ahead of TileGrid, so we poll briefly. Done-once per session via the
 *  module-scoped guard; `clearMask` in Leva still works normally after.
 *
 *  Skip if a mask is ALREADY active (user uploaded their own mask before
 *  this hook finished polling, or buildDiorama's preservation of
 *  grassRefs.activeMask already re-applied a prior mask on a rebuild
 *  cascade). Prevents clobbering a user's custom upload. */
let defaultMaskApplied = false
async function applyDefaultGrassMask() {
  if (defaultMaskApplied) return
  // Wait for the rebuild hook (published by TileGrid after grass build).
  for (let i = 0; i < 60 && !grassRefs.rebuildWithMask; i++) {
    await new Promise(r => setTimeout(r, 50))
  }
  if (!grassRefs.rebuildWithMask) {
    // eslint-disable-next-line no-console
    console.warn('[grass] rebuildWithMask not available after 3s — skipping default mask')
    return
  }
  // If a mask already exists (user uploaded in the meantime, or a cascade
  // rebuild restored one from grassRefs.activeMask), don't overwrite.
  if (grassRefs.activeMask) {
    defaultMaskApplied = true
    return
  }
  const data = await rasterizePngToImageData(DEFAULT_GRASS_MASK_URL)
  if (!data) {
    // eslint-disable-next-line no-console
    console.warn('[grass] default mask PNG failed to load')
    return
  }
  // Re-check after async load — a user mask may have been uploaded during
  // the fetch/decode window.
  if (grassRefs.activeMask) {
    defaultMaskApplied = true
    return
  }
  grassRefs.rebuildWithMask(data)
  defaultMaskApplied = true
}

/** Same painter as DensityMapOverlay but writes to any given dimensions.
 *  Refactor target if the overlay grows more chrome — keep them in sync. */
function renderOverlayCanvas(w: number, h: number): HTMLCanvasElement | null {
  const data = grassDebug.data
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!data || !ctx) return null

  const pad = 16
  const domW = data.halfW * 2
  const domH = data.halfH * 2
  const scale = Math.min((w - pad * 2) / domW, (h - pad * 2) / domH)
  const cx = w / 2
  const cy = h / 2
  const toPxX = (x: number) => cx + x * scale
  const toPxY = (z: number) => cy + z * scale

  ctx.fillStyle = '#0b0d12'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = '#2a2f3a'
  ctx.lineWidth = 1
  ctx.strokeRect(toPxX(-data.halfW), toPxY(-data.halfH), domW * scale, domH * scale)

  ctx.fillStyle = '#14281c'
  ctx.strokeStyle = '#3a6a45'
  for (const b of data.blocks) {
    const x0 = toPxX(b.cx - b.halfX)
    const y0 = toPxY(b.cz - b.halfZ)
    const ww = b.halfX * 2 * scale
    const hh = b.halfZ * 2 * scale
    ctx.fillRect(x0, y0, ww, hh)
    ctx.strokeRect(x0, y0, ww, hh)
    ctx.fillStyle = '#88c098'
    ctx.font = `${Math.max(11, Math.floor(scale * 0.06))}px system-ui`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(b.face < 0 ? 'ground' : `F${b.face}`, toPxX(b.cx), toPxY(b.cz))
    ctx.fillStyle = '#14281c'
  }

  for (const e of data.exclusions) {
    const col = PROP_COLOUR[e.owner] ?? '#ff4444'
    ctx.fillStyle = col + '66'
    ctx.strokeStyle = col + 'cc'
    ctx.lineWidth = 0.8
    const x0 = toPxX(e.xMin)
    const y0 = toPxY(e.zMin)
    ctx.fillRect(x0, y0, (e.xMax - e.xMin) * scale, (e.zMax - e.zMin) * scale)
    ctx.strokeRect(x0, y0, (e.xMax - e.xMin) * scale, (e.zMax - e.zMin) * scale)
  }

  ctx.fillStyle = 'rgba(223, 221, 112, 0.85)'
  const pts = data.flatPositions
  for (let i = 0; i < pts.length; i += 2) {
    ctx.fillRect(toPxX(pts[i]) - 0.5, toPxY(pts[i + 1]) - 0.5, 1.6, 1.6)
  }

  ctx.fillStyle = '#cccccc'
  ctx.font = '14px system-ui'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(
    `allowed ${data.stats.allowed} / candidates ${data.stats.candidates}  ` +
    `(${Math.round((data.stats.allowed / data.stats.candidates) * 100)}%)`,
    12, 10,
  )
  return c
}

// ── Density map overlay ───────────────────────────────────────────────────

// Per-prop colour so legend reading works at a glance. Roygbiv-ish spread,
// pastel so dots over the fill are still visible.
const PROP_COLOUR: Record<string, string> = {
  road:      '#d85c5c',
  pond:      '#4e8fd6',
  stream:    '#4e8fd6',
  windmill:  '#c97dc9',
  trees:     '#6fb86f',
  hut:       '#d6a24e',
  fence:     '#8c7a5e',
  flowers:   '#e77fb5',
  stonepath: '#9d9d9d',
  well:      '#5fa8a8',
  rocks:     '#7f8084',
  smoke:     '#bdbdbd',
  car:       '#c97dc9',
}

function DensityMapOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const data = grassDebug.data
    const canvas = canvasRef.current
    if (!data || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Map flat (x: [-halfW, halfW], z: [-halfH, halfH]) → pixel space.
    const pad = 12
    const W = canvas.width
    const H = canvas.height
    const domW = data.halfW * 2
    const domH = data.halfH * 2
    const scale = Math.min((W - pad * 2) / domW, (H - pad * 2) / domH)
    const cx = W / 2
    const cy = H / 2
    const toPxX = (x: number) => cx + x * scale
    const toPxY = (z: number) => cy + z * scale // +z goes down in preview

    // Background
    ctx.fillStyle = '#0b0d12'
    ctx.fillRect(0, 0, W, H)

    // 8×6 outer bounds
    ctx.strokeStyle = '#2a2f3a'
    ctx.lineWidth = 1
    ctx.strokeRect(
      toPxX(-data.halfW), toPxY(-data.halfH),
      domW * scale, domH * scale,
    )

    // Ground rect(s) — the allowed emission domain, pulled from the
    // ground/terrain mesh's XZ AABB (face === -1 for the single ground entry).
    ctx.fillStyle = '#14281c'
    ctx.strokeStyle = '#3a6a45'
    ctx.lineWidth = 1
    for (const b of data.blocks) {
      const x0 = toPxX(b.cx - b.halfX)
      const y0 = toPxY(b.cz - b.halfZ)
      const w  = b.halfX * 2 * scale
      const h  = b.halfZ * 2 * scale
      ctx.fillRect(x0, y0, w, h)
      ctx.strokeRect(x0, y0, w, h)
      ctx.fillStyle = '#88c098'
      ctx.font = '11px system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(b.face < 0 ? 'ground' : `F${b.face}`, toPxX(b.cx), toPxY(b.cz))
      ctx.fillStyle = '#14281c'
    }

    // Exclusion rects first (per-prop colour, translucent) — so surviving
    // blade positions painted on top read as clearly "allowed".
    for (const e of data.exclusions) {
      const col = PROP_COLOUR[e.owner] ?? '#ff4444'
      ctx.fillStyle = col + '66' // ~40% alpha
      ctx.strokeStyle = col + 'cc'
      ctx.lineWidth = 0.8
      const x0 = toPxX(e.xMin)
      const y0 = toPxY(e.zMin)
      const w  = (e.xMax - e.xMin) * scale
      const h  = (e.zMax - e.zMin) * scale
      ctx.fillRect(x0, y0, w, h)
      ctx.strokeRect(x0, y0, w, h)
    }

    // Allowed blade positions (small yellow dots on top).
    const pts = data.flatPositions
    ctx.fillStyle = 'rgba(223, 221, 112, 0.85)'
    for (let i = 0; i < pts.length; i += 2) {
      ctx.fillRect(toPxX(pts[i]) - 0.5, toPxY(pts[i + 1]) - 0.5, 1.6, 1.6)
    }

    // Stats
    ctx.fillStyle = '#cccccc'
    ctx.font = '11px system-ui'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(
      `allowed ${data.stats.allowed} / candidates ${data.stats.candidates}  ` +
      `(${Math.round((data.stats.allowed / data.stats.candidates) * 100)}%)`,
      8, 6,
    )
  })

  return (
    <div
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 40,
        padding: 8,
        background: 'rgba(10, 13, 18, 0.92)',
        border: '1px solid #2a2f3a',
        borderRadius: 4,
        pointerEvents: 'none',
      }}
    >
      <canvas ref={canvasRef} width={640} height={480} style={{ display: 'block' }} />
    </div>
  )
}
