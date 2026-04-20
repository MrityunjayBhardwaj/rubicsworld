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
import { grassDebug, grassRefs, grassUniforms } from '../diorama/buildGrass'

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
  // Allowed face blocks → white.
  ctx.fillStyle = '#fff'
  for (const b of data.blocks) {
    ctx.fillRect(
      toPxX(b.cx - b.halfSize),
      toPxY(b.cz - b.halfSize),
      b.halfSize * 2 * scale,
      b.halfSize * 2 * scale,
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
        density:       { value: 5.0, min: 0, max: 10, step: 0.05, label: 'density' },
        length:        { value: grassUniforms.uLengthScale.value,  min: 0.1, max: 6, step: 0.01, label: 'length' },
        windSpeed:     { value: grassUniforms.uWindFreq.value,     min: 0, max: 6, step: 0.01, label: 'wind speed' },
        windStrength:  { value: grassUniforms.uWindStrength.value, min: 0, max: 4, step: 0.01, label: 'wind strength' },
        bendAmount:    { value: grassUniforms.uBendAmount.value,   min: 0, max: 1.2, step: 0.005, label: 'bend (rad)' },
        waveScale:     { value: grassUniforms.uWaveScale.value,    min: 0, max: 12, step: 0.05, label: 'wave scale (spatial)' },
        windDirX:      { value: grassUniforms.uWindDir.value.x,    min: -1, max: 1, step: 0.01, label: 'wind dir x' },
        windDirZ:      { value: grassUniforms.uWindDir.value.y,    min: -1, max: 1, step: 0.01, label: 'wind dir z' },
        baseColor:     { value: '#' + grassUniforms.uBaseColor.value.getHexString(), label: 'base colour' },
        tipColor:      { value: '#' + grassUniforms.uTipColor.value.getHexString(),  label: 'tip colour' },
        hueJitter:     { value: grassUniforms.uHueJitter.value, min: 0, max: 0.5, step: 0.01, label: 'hue jitter' },
        densityMap:    { value: false, label: 'show density map' },
        saveDensityMap: button(() => saveOverlayPng()),
        saveMask:       button(() => saveMaskPng()),
        saveCubenet:    button(() => { void saveCubenetPng() }),
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
  }, [
    controls.windStrength, controls.windSpeed, controls.waveScale,
    controls.bendAmount, controls.length,
    controls.windDirX, controls.windDirZ,
    controls.hueJitter, controls.baseColor, controls.tipColor,
  ])

  useEffect(() => {
    const m = grassRefs.mesh
    if (!m) return
    m.visible = controls.visible
    // Slider 0..10 maps to 0..maxCount. density=10 shows the full allocated
    // budget (lush field); density=1 ≈ the old default coverage.
    const frac = Math.min(1, Math.max(0, controls.density / 10))
    m.count = Math.floor(grassRefs.maxCount * frac)
  }, [controls.visible, controls.density])

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
  console.log('[grass] saveCubenetPng start, captureTopView:', !!grassRefs.captureTopView)
  if (!grassRefs.captureTopView) return
  const blob = await grassRefs.captureTopView().catch(e => {
    console.error('[grass] captureTopView threw', e); return null
  })
  console.log('[grass] saveCubenetPng blob:', blob?.size)
  if (!blob) return
  // Blob URLs handle the ~800 KB rendered PNG reliably; base64 data URLs at
  // that size occasionally fail to trigger the download in Chromium.
  const url = URL.createObjectURL(blob)
  triggerDownload(url, `grass-cubenet_${tstamp()}.png`)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
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
    const x0 = toPxX(b.cx - b.halfSize)
    const y0 = toPxY(b.cz - b.halfSize)
    const ww = b.halfSize * 2 * scale
    const hh = b.halfSize * 2 * scale
    ctx.fillRect(x0, y0, ww, hh)
    ctx.strokeRect(x0, y0, ww, hh)
    ctx.fillStyle = '#88c098'
    ctx.font = `${Math.max(11, Math.floor(scale * 0.06))}px system-ui`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`F${b.face}`, toPxX(b.cx), toPxY(b.cz))
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

    // Face-block rectangles (allowed domain)
    ctx.fillStyle = '#14281c'
    ctx.strokeStyle = '#3a6a45'
    ctx.lineWidth = 1
    for (const b of data.blocks) {
      const x0 = toPxX(b.cx - b.halfSize)
      const y0 = toPxY(b.cz - b.halfSize)
      const w  = b.halfSize * 2 * scale
      const h  = b.halfSize * 2 * scale
      ctx.fillRect(x0, y0, w, h)
      ctx.strokeRect(x0, y0, w, h)
      // face label (cube-face convention)
      ctx.fillStyle = '#88c098'
      ctx.font = '11px system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`F${b.face}`, toPxX(b.cx), toPxY(b.cz))
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
