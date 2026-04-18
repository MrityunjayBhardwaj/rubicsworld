import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { HDRI_PRESETS, useHdri, type HdriPreset } from './hdriStore'

/**
 * Floating HTML panel for uploading an HDRI and controlling exposure / blur /
 * rotation / background opacity. Keeps Leva uncluttered and lets the preview
 * thumbnail live alongside the file input naturally.
 *
 * HDR/EXR files aren't renderable via <img>, so the preview is produced by
 * loading with three's RGBELoader/EXRLoader and tone-mapping the radiance
 * data to an 8-bit canvas. One-shot per upload; tiny (256×128) and
 * mirror-wrapping so the horizontal edges blend.
 */

const THUMB_W = 256
const THUMB_H = 128

async function buildHdriThumbnail(url: string, isExr: boolean): Promise<HTMLCanvasElement | null> {
  const loader = isExr ? new EXRLoader() : new RGBELoader()
  loader.setDataType(THREE.FloatType)
  try {
    const tex: THREE.DataTexture = await new Promise((resolve, reject) => {
      loader.load(url, t => resolve(t), undefined, err => reject(err))
    })
    const src = tex.image as { data: Float32Array; width: number; height: number }
    if (!src || !src.data) return null

    const canvas = document.createElement('canvas')
    canvas.width = THUMB_W
    canvas.height = THUMB_H
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const img = ctx.createImageData(THUMB_W, THUMB_H)
    const srcW = src.width
    const srcH = src.height
    // Assume RGBA or RGBE layout with 4 floats per pixel.
    const stride = src.data.length / (srcW * srcH)

    // Simple Reinhard tone map with gamma 2.2. Good enough for a thumbnail.
    const EXP = 0.8
    for (let y = 0; y < THUMB_H; y++) {
      for (let x = 0; x < THUMB_W; x++) {
        const sx = Math.floor((x / THUMB_W) * srcW)
        // Flip V so the preview matches the typical equirectangular orientation
        // seen in apps like Blender (ground at bottom).
        const sy = Math.floor(((THUMB_H - 1 - y) / THUMB_H) * srcH)
        const i = (sy * srcW + sx) * stride
        let r = src.data[i] * EXP
        let g = src.data[i + 1] * EXP
        let b = src.data[i + 2] * EXP
        r = r / (1 + r); g = g / (1 + g); b = b / (1 + b)
        r = Math.pow(r, 1 / 2.2); g = Math.pow(g, 1 / 2.2); b = Math.pow(b, 1 / 2.2)
        const di = (y * THUMB_W + x) * 4
        img.data[di]     = Math.min(255, Math.max(0, r * 255))
        img.data[di + 1] = Math.min(255, Math.max(0, g * 255))
        img.data[di + 2] = Math.min(255, Math.max(0, b * 255))
        img.data[di + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    tex.dispose()
    return canvas
  } catch (err) {
    console.error('[hdri] thumbnail failed:', err)
    return null
  }
}

export function HDRIPanel() {
  const {
    url, filename, preset,
    blur, intensity, rotation, backgroundOpacity,
    setUrl, setPreset, setBlur, setIntensity, setRotation, setBackgroundOpacity,
  } = useHdri()

  const fileRef = useRef<HTMLInputElement | null>(null)
  const previewWrapRef = useRef<HTMLDivElement | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // When url changes, rebuild the preview thumbnail.
  useEffect(() => {
    const wrap = previewWrapRef.current
    if (!wrap) return
    // Clear old preview
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild)
    if (!url) {
      const hint = document.createElement('div')
      hint.textContent = 'preset: ' + preset
      hint.style.cssText = 'color:#aaa;font-size:10px;padding:4px 0;'
      wrap.appendChild(hint)
      return
    }
    setPreviewBusy(true)
    const isExr = (filename ?? '').toLowerCase().endsWith('.exr')
    buildHdriThumbnail(url, isExr).then(canvas => {
      setPreviewBusy(false)
      if (!wrap || !canvas) return
      canvas.style.cssText = 'width:100%;height:auto;display:block;border-radius:3px;'
      wrap.appendChild(canvas)
    })
  }, [url, filename, preset])

  const onPickFile = () => fileRef.current?.click()

  const onFileChange: React.ChangeEventHandler<HTMLInputElement> = e => {
    const file = e.target.files?.[0]
    if (!file) return
    const name = file.name.toLowerCase()
    if (!name.endsWith('.hdr') && !name.endsWith('.exr')) {
      alert('Please upload a .hdr or .exr file')
      return
    }
    // Revoke the old blob URL if present
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
    const blobUrl = URL.createObjectURL(file)
    setUrl(blobUrl, file.name)
    // Reset the native input so the same file can be re-selected
    e.target.value = ''
  }

  const onUsePreset = () => {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
    setUrl(null, null)
  }

  return (
    <div style={{
      position: 'fixed',
      top: 12,
      left: 12,
      width: 280,
      background: 'rgba(8, 10, 14, 0.9)',
      border: '1px solid #333',
      color: '#e0e0e0',
      padding: collapsed ? '8px 12px' : '10px 12px',
      borderRadius: 6,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11,
      lineHeight: 1.5,
      userSelect: 'none',
      zIndex: 90,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ opacity: 0.55, fontSize: 10, letterSpacing: 0.5 }}>HDRI</div>
        <button onClick={() => setCollapsed(c => !c)} style={btnFlatStyle}>{collapsed ? '＋' : '−'}</button>
      </div>
      {!collapsed && (
        <>
          <div
            ref={previewWrapRef}
            style={{
              marginTop: 6,
              minHeight: 22,
              background: '#0d1016',
              borderRadius: 3,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: previewBusy ? 0.5 : 1,
            }}
          />
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={onPickFile} style={btnStyle}>Upload HDR/EXR</button>
            {url && <button onClick={onUsePreset} style={btnStyle}>Use preset</button>}
          </div>
          {url && filename && (
            <div style={{ marginTop: 4, fontSize: 10, opacity: 0.6, wordBreak: 'break-all' }}>{filename}</div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".hdr,.exr"
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
          {!url && (
            <Row label="Preset">
              <select
                value={preset}
                onChange={e => setPreset(e.target.value as HdriPreset)}
                style={selectStyle}
              >
                {HDRI_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </Row>
          )}
          <SliderRow label="Exposure" value={intensity} min={0} max={3} step={0.05} onChange={setIntensity} />
          <SliderRow label="Blur" value={blur} min={0} max={1} step={0.01} onChange={setBlur} />
          <SliderRow
            label="Rotation°"
            value={(rotation * 180) / Math.PI}
            min={0}
            max={360}
            step={1}
            onChange={v => setRotation((v * Math.PI) / 180)}
          />
          <SliderRow label="BG opacity" value={backgroundOpacity} min={0} max={1} step={0.01} onChange={setBackgroundOpacity} />
        </>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 80, opacity: 0.6 }}>{label}</div>
      {children}
    </div>
  )
}

function SliderRow({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}) {
  return (
    <Row label={label}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <div style={{ width: 44, textAlign: 'right', opacity: 0.8 }}>
        {value.toFixed(step < 1 ? 2 : 0)}
      </div>
    </Row>
  )
}

const btnStyle: React.CSSProperties = {
  background: '#1b2330',
  color: '#e0e0e0',
  border: '1px solid #2a3546',
  padding: '4px 10px',
  borderRadius: 3,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
}

const btnFlatStyle: React.CSSProperties = {
  ...btnStyle,
  padding: '0 6px',
  fontSize: 14,
  lineHeight: 1,
}

const selectStyle: React.CSSProperties = {
  flex: 1,
  background: '#1b2330',
  color: '#e0e0e0',
  border: '1px solid #2a3546',
  padding: '3px 6px',
  borderRadius: 3,
  fontFamily: 'inherit',
  fontSize: 11,
}
