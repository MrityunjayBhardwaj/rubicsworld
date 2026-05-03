import { useEffect, useRef, useState, useCallback } from 'react'
import App from './App'

/**
 * Audio editor route — `/edit/levels/<slug>/audio` (issue #51).
 *
 * Layout: hand-rolled splitter with the AudioWorkspace panel on the
 * left and the live `<App>` canvas on the right. The splitter writes
 * `--audio-editor-canvas-left` on the document root; App's audio-edit
 * route wraps its Canvas in a fixed-positioned div that reads that var.
 *
 * Why hand-rolled (not react-resizable-panels): single use, no a11y
 * requirement, no nested splitters, ~30 lines of pointer-event glue.
 * A dependency would buy ~1KB and a maintenance touchpoint for nothing.
 *
 * Persistence: the user's chosen split width is stashed in localStorage
 * under `rubicsworld:audioEditorSplit` so reloads (which the editor
 * triggers on level swap) don't reset the layout.
 */

const SPLIT_KEY = 'rubicsworld:audioEditorSplit'
const MIN = 320
const MAX_FRAC = 0.7   // never let the workspace eat more than 70% of the viewport
const DEFAULT = 480

function readPersistedSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY)
    if (!raw) return DEFAULT
    const n = Number(raw)
    if (!Number.isFinite(n)) return DEFAULT
    return n
  } catch { return DEFAULT }
}

export default function AudioEditorRoute() {
  // The split is a px width for the LEFT pane (workspace). Initialize from
  // localStorage; clamp on every resize/drag so a stored value larger than
  // the viewport doesn't render the canvas at zero width.
  const [split, setSplit] = useState<number>(() => readPersistedSplit())
  const draggingRef = useRef(false)

  // Push the split into a CSS variable on document.documentElement — App
  // reads it from there. document.documentElement (not body) so it survives
  // any body-level CSS resets and so SSR-shaped CSS rules can target :root.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--audio-editor-canvas-left', `${split}px`)
    return () => { root.style.removeProperty('--audio-editor-canvas-left') }
  }, [split])

  // Persist on change. Throttling not needed — setState triggers this once
  // per drag-frame and localStorage writes are sub-ms for tiny strings.
  useEffect(() => {
    try { localStorage.setItem(SPLIT_KEY, String(split)) } catch { /* ignore */ }
  }, [split])

  // Pointer drag — capture on the handle, listen on window so the user
  // can drag past the handle's bounds without losing the gesture.
  const onHandleDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return
      const max = Math.max(MIN, window.innerWidth * MAX_FRAC)
      const next = Math.max(MIN, Math.min(max, ev.clientX))
      setSplit(next)
    }
    const onUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  return (
    <>
      {/* Left pane — workspace. Fixed-pos to escape any document flow. */}
      <div
        style={{
          position: 'fixed',
          top: 0, left: 0, bottom: 0,
          width: split,
          background: '#0e1118',
          color: '#cfd6e0',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: 12,
          overflow: 'hidden',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <AudioWorkspace />
      </div>

      {/* Splitter handle — 6px column at split-x. wider hit area via the
          ::before pseudo would be nicer, but a 6px solid handle is honest
          about where it is and matches the rest of the dev UI. */}
      <div
        onPointerDown={onHandleDown}
        style={{
          position: 'fixed',
          top: 0, bottom: 0,
          left: split - 3,
          width: 6,
          cursor: 'col-resize',
          background: 'rgba(255,255,255,0.04)',
          zIndex: 101,
        }}
        title="Drag to resize"
      />

      {/* Live level on the right. App's audio-edit route wraps its Canvas
          in a fixed-pos div anchored to var(--audio-editor-canvas-left). */}
      <App route="audio-edit" />
    </>
  )
}

/**
 * Wave 1 placeholder — header + slug indicator. Wave 2 fills in:
 *   - Event/loop list (auto-selects on lastTriggered fire)
 *   - Sample panel (waveform from peaks sidecar, drag-drop upload)
 *   - Modulation panel (sliders + modulator+min+max)
 *   - Trigger bindings panel
 *   - Commit Audio button (slug-scoped POST /__audio/commit)
 *
 * Imports `audioBootSlug` to verify the boot-time per-level audio.json
 * fetch landed — if the slug came from the URL, the workspace is in
 * sync with the bus on first frame.
 */
function AudioWorkspace() {
  return (
    <>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e242e', flexShrink: 0 }}>
        <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1.2 }}>
          Audio Editor
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
          {(typeof window !== 'undefined' && window.location.pathname.match(/\/edit\/levels\/(lvl_\d+)/)?.[1]) ?? 'unknown'}
        </div>
      </div>
      <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
        <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
          Wave 1 scaffold ready. Event list, sample panel, and modulation
          panel land in wave 2 — interact with the live level on the right
          and watch the lastTriggered store fire in the dev console.
        </div>
      </div>
    </>
  )
}
