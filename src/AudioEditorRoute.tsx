import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import App from './App'
import { audioBus, type LoopDef, type EventDef } from './world/audio/bus'
import { audioLive, audioBootSlug } from './world/audio/audioLive'
import { useLastTriggered } from './world/audio/lastTriggered'

/**
 * Audio editor route — `/edit/levels/<slug>/audio` (issue #51).
 *
 * Layout: hand-rolled splitter — AudioWorkspace left, live `<App>` right.
 * App's audio-edit route hides Leva and constrains its Canvas to the
 * right pane via the `--audio-editor-canvas-left` CSS variable.
 *
 * Editing model (live + commit):
 *   - Sliders write to audioBus.setLoopOverride / setEventOverride for
 *     INSTANT preview against the running scene. Overrides multiply on
 *     top of `audioLive.loops[i].params` — the user hears changes the
 *     moment they drag.
 *   - "Commit" button bakes the current overrides INTO `audioLive`'s
 *     entries (so the override layer becomes the new base), then POSTs
 *     a sparse audio.json to /__audio/commit?level=<slug>. Cache-bust on
 *     reload picks up the persisted file (P55).
 *   - Sample swap is a separate flow: drag-drop or file pick → POST raw
 *     bytes to /__audio/upload, set the entry's `src` to the returned
 *     path, register/reload the loop. The bus's loadBuffer normalises
 *     leading-slash (P46) so the registry-shape `src` field is portable.
 */

const SPLIT_KEY = 'rubicsworld:audioEditorSplit'
const MIN = 320
const MAX_FRAC = 0.7
const DEFAULT = 480

function readPersistedSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY)
    if (!raw) return DEFAULT
    const n = Number(raw)
    return Number.isFinite(n) ? n : DEFAULT
  } catch { return DEFAULT }
}

export default function AudioEditorRoute() {
  const [split, setSplit] = useState<number>(() => readPersistedSplit())
  const draggingRef = useRef(false)

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--audio-editor-canvas-left', `${split}px`)
    return () => { root.style.removeProperty('--audio-editor-canvas-left') }
  }, [split])

  useEffect(() => {
    try { localStorage.setItem(SPLIT_KEY, String(split)) } catch { /* ignore */ }
  }, [split])

  const onHandleDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return
      const max = Math.max(MIN, window.innerWidth * MAX_FRAC)
      setSplit(Math.max(MIN, Math.min(max, ev.clientX)))
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

      <App route="audio-edit" />
    </>
  )
}

// ── AudioWorkspace ─────────────────────────────────────────────────────

type Entry =
  | { kind: 'loop'; def: LoopDef }
  | { kind: 'event'; def: EventDef }

function AudioWorkspace() {
  // Live snapshot of audioLive — re-read on a small ticker so commits
  // and registry edits surface in the list. audioLive mutations don't
  // route through React; the ticker is the simplest reactivity layer.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 500)
    return () => clearInterval(id)
  }, [])
  void tick

  const entries: Entry[] = useMemo(() => [
    ...audioLive.loops.map((def): Entry => ({ kind: 'loop', def })),
    ...audioLive.events.map((def): Entry => ({ kind: 'event', def })),
    // tick is intentionally a dep — forces re-list on heartbeat
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [tick])

  const [selectedKey, setSelectedKey] = useState<string | null>(
    entries[0]?.def.key ?? null,
  )
  const lockSelection = useRef(false)

  // Auto-select on lastTriggered fire (unless lock toggle is on).
  const lastKey = useLastTriggered(s => s.key)
  const lastN = useLastTriggered(s => s.n)
  useEffect(() => {
    if (lockSelection.current) return
    if (lastKey) setSelectedKey(lastKey)
  }, [lastKey, lastN])

  const selected = entries.find(e => e.def.key === selectedKey) ?? entries[0] ?? null

  const slug = audioBootSlug
  const [committing, setCommitting] = useState<'idle' | 'committing' | 'ok' | 'err'>('idle')
  const onCommit = useCallback(async () => {
    if (!slug) { setCommitting('err'); return }
    setCommitting('committing')
    try {
      const json = buildSparseAudioJson()
      const res = await fetch(`/__audio/commit?level=${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json, null, 2),
      })
      if (!res.ok) throw new Error(`commit failed: ${res.status}`)
      setCommitting('ok')
      setTimeout(() => setCommitting('idle'), 1500)
    } catch (err) {
      console.error('[audio-editor] commit failed:', err)
      setCommitting('err')
      setTimeout(() => setCommitting('idle'), 2500)
    }
  }, [slug])

  return (
    <>
      {/* Header — slug + commit */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #1e242e',
        flexShrink: 0,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1.2 }}>
            Audio Editor
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {slug ?? 'no level'}
          </div>
        </div>
        <button
          onClick={onCommit}
          disabled={!slug || committing === 'committing'}
          style={{
            padding: '6px 12px',
            background: committing === 'ok' ? '#244a30' : committing === 'err' ? '#4a2424' : '#1e242e',
            color: '#cfd6e0',
            border: '1px solid #2a323d',
            borderRadius: 4,
            cursor: slug ? 'pointer' : 'not-allowed',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {committing === 'committing' ? 'Committing…'
            : committing === 'ok' ? 'Committed'
            : committing === 'err' ? 'Failed'
            : 'Commit Audio'}
        </button>
      </div>

      {/* Two-row split inside the workspace: list (top) + inspector (bottom) */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <EventList
          entries={entries}
          selectedKey={selected?.def.key ?? null}
          onSelect={setSelectedKey}
          lockSelection={lockSelection}
        />
        <Inspector entry={selected} />
      </div>
    </>
  )
}

// ── Event/loop list ────────────────────────────────────────────────────

function EventList({
  entries,
  selectedKey,
  onSelect,
  lockSelection,
}: {
  entries: Entry[]
  selectedKey: string | null
  onSelect: (k: string) => void
  lockSelection: React.MutableRefObject<boolean>
}) {
  const lastKey = useLastTriggered(s => s.key)
  const lastN = useLastTriggered(s => s.n)
  // Flash state — when lastN changes, mark that key briefly.
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null)
  useEffect(() => {
    if (!lastKey) return
    setFlash({ key: lastKey, n: lastN })
    const id = setTimeout(() => setFlash(null), 600)
    return () => clearTimeout(id)
  }, [lastKey, lastN])

  const [, force] = useState(0)
  return (
    <div style={{
      flex: '1 1 50%',
      minHeight: 100,
      borderBottom: '1px solid #1e242e',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        padding: '6px 12px',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 1.2,
        opacity: 0.55,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid #14191f',
      }}>
        <span>{entries.length} events / loops</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', textTransform: 'none', letterSpacing: 0 }}>
          <input
            type="checkbox"
            defaultChecked={false}
            onChange={(e) => { lockSelection.current = e.target.checked; force(x => x + 1) }}
            style={{ margin: 0 }}
          />
          Lock selection
        </label>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {entries.map(e => {
          const isSel = e.def.key === selectedKey
          const isFlash = flash?.key === e.def.key
          return (
            <div
              key={`${e.kind}:${e.def.key}`}
              onClick={() => onSelect(e.def.key)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                background: isSel ? '#1a2330' : isFlash ? '#23332b' : 'transparent',
                borderLeft: `3px solid ${isSel ? '#4a8eef' : isFlash ? '#5fcf86' : 'transparent'}`,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                transition: 'background 0.2s',
              }}
            >
              <span style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 2,
                background: e.kind === 'loop' ? '#2a3548' : '#3d2e2e',
                color: e.kind === 'loop' ? '#7aa8ef' : '#ef9a7a',
                fontWeight: 600,
                letterSpacing: 0.5,
              }}>
                {e.kind === 'loop' ? 'LOOP' : 'EVT'}
              </span>
              <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                {e.def.key}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Inspector ──────────────────────────────────────────────────────────

function Inspector({ entry }: { entry: Entry | null }) {
  if (!entry) {
    return (
      <div style={{ flex: '1 1 50%', padding: 16, opacity: 0.5, fontStyle: 'italic' }}>
        No entry selected.
      </div>
    )
  }
  return (
    <div style={{ flex: '1 1 50%', minHeight: 200, padding: 12, overflowY: 'auto' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{entry.def.key}</div>
      <div style={{ fontSize: 11, opacity: 0.7, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', marginBottom: 12 }}>
        {entry.def.src}
      </div>
      <SampleSwap entry={entry} />
      {entry.kind === 'loop'
        ? <LoopOverrides entry={entry.def} />
        : <EventOverrides entry={entry.def} />
      }
    </div>
  )
}

function SampleSwap({ entry }: { entry: Entry }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<string | null>(null)
  const slug = audioBootSlug

  const onPick = useCallback(async (file: File) => {
    if (!slug) { setStatus('no slug — open under /edit/levels/<slug>/audio'); return }
    setStatus('Uploading…')
    try {
      const buf = await file.arrayBuffer()
      const res = await fetch(`/__audio/upload?level=${encodeURIComponent(slug)}&filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: buf,
      })
      const json = await res.json() as { ok: boolean; src?: string; error?: string }
      if (!json.ok || !json.src) throw new Error(json.error ?? 'upload failed')
      // Mutate audioLive's entry, then ask the bus to reload the loop so
      // the new buffer attaches. Events re-resolve src on every play().
      entry.def.src = json.src
      if (entry.kind === 'loop') {
        // registerLoop is idempotent + handles existing keys (replaces def
        // and re-attaches with the new buffer once loaded).
        audioBus.registerLoop(entry.def)
      }
      setStatus(`OK: ${json.src}`)
      setTimeout(() => setStatus(null), 2500)
    } catch (err) {
      setStatus(`Failed: ${String(err)}`)
      setTimeout(() => setStatus(null), 4000)
    }
  }, [entry, slug])

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        Sample
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".wav,.mp3,.ogg,.flac"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) void onPick(f)
          e.target.value = ''
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        style={btn}
      >
        Replace sample…
      </button>
      {status && (
        <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{status}</div>
      )}
    </div>
  )
}

function LoopOverrides({ entry }: { entry: LoopDef }) {
  const [, force] = useState(0)
  const ovr = audioBus.getLoopOverride(entry.key) ?? {}
  const set = (next: Parameters<typeof audioBus.setLoopOverride>[1]) => {
    audioBus.setLoopOverride(entry.key, next)
    force(x => x + 1)
  }
  return (
    <div>
      <Slider label="Volume mul" value={ovr.vol ?? 1} min={0} max={2} step={0.01} onChange={v => set({ vol: v })} />
      <Slider label="Speed mul"  value={ovr.speed ?? 1} min={0.25} max={2} step={0.01} onChange={v => set({ speed: v })} />
      {entry.radius != null && (
        <Slider label="Radius" value={ovr.radius ?? entry.radius} min={1} max={50} step={0.5} onChange={v => set({ radius: v })} />
      )}
      <Toggle label="Mute" value={ovr.mute ?? false} onChange={v => set({ mute: v })} />
    </div>
  )
}

function EventOverrides({ entry }: { entry: EventDef }) {
  const [, force] = useState(0)
  const ovr = audioBus.getEventOverride(entry.key) ?? {}
  const set = (next: Parameters<typeof audioBus.setEventOverride>[1]) => {
    audioBus.setEventOverride(entry.key, next)
    force(x => x + 1)
  }
  return (
    <div>
      <Slider label="Volume mul" value={ovr.vol ?? 1} min={0} max={2} step={0.01} onChange={v => set({ vol: v })} />
      <Slider label="Speed mul"  value={ovr.speed ?? 1} min={0.25} max={2} step={0.01} onChange={v => set({ speed: v })} />
      <Toggle label="Mute" value={ovr.mute ?? false} onChange={v => set({ mute: v })} />
      <button
        style={{ ...btn, marginTop: 8 }}
        onClick={() => audioBus.play(entry.key)}
      >
        ▶ Audition
      </button>
    </div>
  )
}

// ── Tiny inline controls ───────────────────────────────────────────────

function Slider({
  label, value, min, max, step, onChange,
}: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
        <span style={{ opacity: 0.7 }}>{label}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace', opacity: 0.9 }}>{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#4a8eef' }}
      />
    </label>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, cursor: 'pointer', fontSize: 11 }}>
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

const btn: React.CSSProperties = {
  padding: '5px 10px',
  background: '#1e242e',
  color: '#cfd6e0',
  border: '1px solid #2a323d',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 11,
}

// ── Commit shape ───────────────────────────────────────────────────────

/**
 * Build the sparse audio.json to POST. For each loop / event, if any
 * override is non-default, emit an entry that bakes the override into
 * the persistable shape. Loops with a `vol` override multiply
 * params.vol.base; speed/radius override the corresponding fields.
 *
 * We don't (yet) write back the full registry shape — only the entries
 * the user actually changed. The boot-time XHR keyed-merges this onto
 * the global registry, so unchanged entries remain at their defaults
 * (matching settings.json layering behavior — P55).
 */
function buildSparseAudioJson(): { loops?: LoopDef[]; events?: EventDef[] } {
  const out: { loops?: LoopDef[]; events?: EventDef[] } = {}

  const loops: LoopDef[] = []
  for (const def of audioLive.loops) {
    const ovr = audioBus.getLoopOverride(def.key)
    if (!ovr || (ovr.vol == null && ovr.speed == null && ovr.radius == null && !ovr.mute)) continue
    const baked: LoopDef = { key: def.key, anchor: def.anchor, src: def.src }
    if (ovr.vol != null) {
      const baseVol = def.params?.vol?.base ?? def.vol ?? 1
      baked.params = { ...(def.params ?? {}), vol: { ...(def.params?.vol ?? {}), base: baseVol * ovr.vol } }
    }
    if (ovr.radius != null) baked.radius = ovr.radius
    loops.push(baked)
  }
  if (loops.length) out.loops = loops

  const events: EventDef[] = []
  for (const def of audioLive.events) {
    const ovr = audioBus.getEventOverride(def.key)
    if (!ovr || (ovr.vol == null && ovr.speed == null && !ovr.mute)) continue
    events.push({ key: def.key, anchor: def.anchor, src: def.src, pitchJitter: def.pitchJitter })
  }
  if (events.length) out.events = events

  return out
}
