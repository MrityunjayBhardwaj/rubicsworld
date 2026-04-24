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
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { flowerColorUniforms, FLOWER_KEYS, grassDebug, grassRefs, grassUniforms, type FlowerKey } from '../diorama/buildGrass'

function triggerDownload(dataUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise(resolve => {
    const r = new FileReader()
    r.onloadend = () => resolve(r.result as string)
    r.readAsDataURL(blob)
  })
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
  const controls = useControls({
    Grass: folder(
      {
        visible:       { value: true },
        density:       { value: 25, min: 0, max: 50, step: 0.1, label: 'density' },
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
        densityMap:    { value: false, label: 'show density map' },
        saveDensityMap: button(() => saveOverlayPng()),
        saveMask:       button(() => saveMaskPng()),
        saveCubenet:    button(() => { void saveCubenetPng() }),
        loadMask:       button(() => { void loadMaskPng() }),
        clearMask:      button(() => { grassRefs.rebuildWithMask?.(null) }),
        saveDioramaGlb: button(() => { void saveDioramaGlb() }),
      },
      { collapsed: true },
    ),
    Flowers: folder(
      {
        flowerPct:    { value: 50, min: 0, max: 100, step: 0.5, label: 'flower % (vs grass)' },
        pinkWeight:   { value: 1.0, min: 0, max: 1, step: 0.01, label: 'pink ratio' },
        purpleWeight: { value: 1.0, min: 0, max: 1, step: 0.01, label: 'purple ratio' },
        yellowWeight: { value: 1.0, min: 0, max: 1, step: 0.01, label: 'yellow ratio' },
        redWeight:    { value: 1.0, min: 0, max: 1, step: 0.01, label: 'red ratio' },
        pinkColor:    { value: '#' + flowerColorUniforms.pink.value.getHexString(),   label: 'pink' },
        purpleColor:  { value: '#' + flowerColorUniforms.purple.value.getHexString(), label: 'purple' },
        yellowColor:  { value: '#' + flowerColorUniforms.yellow.value.getHexString(), label: 'yellow' },
        redColor:     { value: '#' + flowerColorUniforms.red.value.getHexString(),    label: 'red' },
      },
      { collapsed: true },
    ),
  })

  useEffect(() => {
    grassUniforms.uWindStrength.value = controls.windStrength
    grassUniforms.uWindFreq.value     = controls.windSpeed
    grassUniforms.uWaveScale.value    = controls.waveScale
    grassUniforms.uBendAmount.value   = controls.bendAmount
    grassUniforms.uLengthScale.value  = controls.length
    grassUniforms.uWindDir.value.set(controls.windDirX, controls.windDirZ)
    grassUniforms.uHueJitter.value    = controls.hueJitter
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
  const url = URL.createObjectURL(file)
  const img = await new Promise<HTMLImageElement | null>(resolve => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => resolve(null)
    i.src = url
  })
  if (!img) { URL.revokeObjectURL(url); return }
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (!ctx) { URL.revokeObjectURL(url); return }
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, img.width, img.height)
  URL.revokeObjectURL(url)
  grassRefs.rebuildWithMask(data)
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
