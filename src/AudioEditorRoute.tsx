import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import App from './App'
import { audioBus, type LoopDef, type EventDef, type ParamSpec } from './world/audio/bus'
import { audioLive, audioBootSlug } from './world/audio/audioLive'
import { useLastTriggered } from './world/audio/lastTriggered'

/** Loop keys whose params have been edited via the ParamsEditor (#53,
 *  #54). Commit emits these entries' full params block so the persisted
 *  audio.json matches what the user is hearing. Module-scope (not React
 *  state) because Inspector unmounts when selection changes — we'd lose
 *  the set if it lived in component state. */
const editedParamKeys = new Set<string>()

/** Filter-type params the editor knows how to add. Bus already wires
 *  BiquadFilters for these names (#54). */
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'] as const

/** All knobs the editor can manage on a loop. `vol` and `rate` are
 *  always present once a user touches them; filters are opt-in via the
 *  Add Filter buttons. */
const PARAM_TYPES = ['vol', 'rate', ...FILTER_TYPES] as const
type ParamType = typeof PARAM_TYPES[number]

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
      <div style={{ fontSize: 11, opacity: 0.7, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', marginBottom: 8 }}>
        {entry.def.src}
      </div>
      <WaveformCanvas src={entry.def.src} />
      <SampleSwap entry={entry} />
      {entry.kind === 'loop'
        ? <>
            <LoopOverrides entry={entry.def} />
            <ParamsEditor loopKey={entry.def.key} />
          </>
        : <EventOverrides entry={entry.def} />
      }
    </div>
  )
}

// ── WaveformCanvas — peaks sidecar + render (#52) ──────────────────────

interface PeaksSidecar {
  /** Length-N min/max pairs flattened: [min0, max0, min1, max1, ...]. */
  peaks: number[]
  duration: number
  sampleRate: number
  /** Generator version — bump to force regenerate when the algorithm
   *  changes. Sidecar files older than `PEAKS_VERSION` are recomputed. */
  v: number
}

const PEAKS_VERSION = 1
const PEAKS_BUCKETS = 512   // canvas columns; one min/max pair per bucket

/**
 * Downsample an AudioBuffer to PEAKS_BUCKETS min/max pairs. Single
 * channel only (mix down to mono if multi-channel) — the editor's
 * waveform is for visual orientation, not stereo analysis.
 */
function computePeaks(buf: AudioBuffer): PeaksSidecar {
  const ch0 = buf.getChannelData(0)
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null
  const stride = Math.max(1, Math.floor(ch0.length / PEAKS_BUCKETS))
  const peaks: number[] = []
  for (let i = 0; i < PEAKS_BUCKETS; i++) {
    let mn = 1, mx = -1
    const start = i * stride
    const end = Math.min(ch0.length, start + stride)
    for (let j = start; j < end; j++) {
      const v = ch1 ? (ch0[j] + ch1[j]) * 0.5 : ch0[j]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    if (mn > mx) { mn = 0; mx = 0 } // empty bucket — flat line
    peaks.push(mn, mx)
  }
  return { peaks, duration: buf.duration, sampleRate: buf.sampleRate, v: PEAKS_VERSION }
}

/** Try to fetch a sidecar peaks file. Returns null if missing or stale
 *  (different generator version). */
async function fetchPeaks(src: string): Promise<PeaksSidecar | null> {
  try {
    // Sidecars are public-relative — same as `src`. Add leading slash
    // to match bus.loadBuffer normalisation (P46).
    const url = '/' + src + '.peaks.json'
    const res = await fetch(url)
    if (!res.ok) return null
    const json = await res.json() as PeaksSidecar
    if (json.v !== PEAKS_VERSION) return null
    return json
  } catch { return null }
}

/** Generate peaks client-side (decode via the bus' cached buffer if
 *  available) and POST sidecar for next time. */
async function generateAndCachePeaks(src: string): Promise<PeaksSidecar | null> {
  try {
    const buf = await audioBus.loadSampleBuffer(src)
    const sidecar = computePeaks(buf)
    // Fire-and-forget — render even if the sidecar write fails.
    void fetch(`/__audio/peaks?src=${encodeURIComponent(src)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sidecar),
    }).catch(() => { /* ignore */ })
    return sidecar
  } catch (err) {
    console.warn('[audio-editor] peaks generation failed:', err)
    return null
  }
}

function WaveformCanvas({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<PeaksSidecar | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  // Synth-backed loops have no buffer — short-circuit. The check is on
  // the registry-shape src, before any fetch.
  const isSynth = src.startsWith('synth:')

  useEffect(() => {
    if (isSynth) { setStatus('ready'); setPeaks(null); return }
    let cancelled = false
    setStatus('loading')
    setPeaks(null)
    ;(async () => {
      const cached = await fetchPeaks(src)
      if (cancelled) return
      if (cached) { setPeaks(cached); setStatus('ready'); return }
      const generated = await generateAndCachePeaks(src)
      if (cancelled) return
      if (generated) { setPeaks(generated); setStatus('ready') }
      else setStatus('error')
    })()
    return () => { cancelled = true }
  }, [src, isSynth])

  // Render — runs on peaks change, on canvas mount, and on resize via
  // the ResizeObserver below.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#0a0d12'
    ctx.fillRect(0, 0, w, h)
    // Centre line
    ctx.strokeStyle = '#1e242e'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2)
    ctx.lineTo(w, h / 2)
    ctx.stroke()
    // Peaks — one vertical line per bucket from min..max.
    ctx.strokeStyle = '#4a8eef'
    ctx.lineWidth = 1
    const n = peaks.peaks.length / 2
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w
      const mn = peaks.peaks[i * 2]
      const mx = peaks.peaks[i * 2 + 1]
      const y0 = h / 2 - mx * (h / 2 - 1)
      const y1 = h / 2 - mn * (h / 2 - 1)
      ctx.beginPath()
      ctx.moveTo(x, y0)
      ctx.lineTo(x, y1 || y0 + 1) // ensure a 1px line for silent buckets
      ctx.stroke()
    }
  }, [peaks])

  if (isSynth) {
    return (
      <div style={{
        marginBottom: 12, padding: 12, background: '#141a23',
        border: '1px dashed #2a323d', borderRadius: 4,
        fontSize: 11, opacity: 0.6, fontStyle: 'italic',
      }}>
        Synth voice — no sample buffer to display.
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: 80, display: 'block', borderRadius: 3, background: '#0a0d12' }}
      />
      {status === 'loading' && (
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>Generating peaks…</div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 10, opacity: 0.6, color: '#ef9a7a', marginTop: 2 }}>Peaks unavailable</div>
      )}
      {status === 'ready' && peaks && (
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
          {peaks.duration.toFixed(2)}s · {peaks.sampleRate} Hz
        </div>
      )}
    </div>
  )
}

// ── ParamsEditor — modulator + min/max + filters (#53, #54) ────────────

/**
 * Edits the persistent param spec (`{ base, modulator, min, max, invert }`)
 * for each knob on a loop. Distinct from LoopOverrides above:
 *   - LoopOverrides = ephemeral live multipliers (vol/speed/radius). Resets
 *     on reload unless Commit folds them into base.
 *   - ParamsEditor   = direct edits to the registry-shape spec, applied
 *     instantly via `audioBus.setLoopParamSpec` (no node teardown). Commit
 *     emits the full params block for any loop touched here.
 *
 * Filter params (lowpass/highpass/bandpass) are just regular params — the
 * bus reads `params.lowpass` and routes it to a BiquadFilter's frequency
 * AudioParam. So #54 falls out of the same UI: an "Add Filter" button
 * inserts a new param key with sensible defaults, then the row edits it.
 */
function ParamsEditor({ loopKey }: { loopKey: string }) {
  const [, force] = useState(0)
  const rerender = () => force(x => x + 1)

  const def = audioBus.getLoopRuntimeDef(loopKey)
  if (!def) {
    return (
      <div style={{ marginTop: 12, opacity: 0.5, fontSize: 11, fontStyle: 'italic' }}>
        Loop not yet attached — params hidden until the bus initialises.
      </div>
    )
  }

  const params = def.params ?? {}
  const presentKeys = Object.keys(params) as ParamType[]
  const missingFilters = FILTER_TYPES.filter(t => !presentKeys.includes(t))
  const modNames = audioBus.listModulatorNames()

  const updateParam = (name: string, partial: Partial<ParamSpec>) => {
    const cur = params[name] ?? {}
    audioBus.setLoopParamSpec(loopKey, name, { ...cur, ...partial })
    editedParamKeys.add(loopKey)
    rerender()
  }

  const addParam = (name: ParamType) => {
    // Sensible defaults per param type. Filters open at midband so the
    // user can immediately drag toward the sound they want.
    const defaults: Record<ParamType, ParamSpec> = {
      vol:      { base: 1 },
      rate:     { base: 1 },
      lowpass:  { base: 4000 },
      highpass: { base: 200 },
      bandpass: { base: 1500 },
    }
    audioBus.setLoopParamSpec(loopKey, name, defaults[name])
    editedParamKeys.add(loopKey)
    rerender()
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #1e242e' }}>
      <div style={{ fontSize: 10, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        Params
      </div>
      {presentKeys.length === 0 && (
        <div style={{ fontSize: 11, opacity: 0.5, fontStyle: 'italic', marginBottom: 8 }}>
          No params defined. Add one below.
        </div>
      )}
      {presentKeys.map(name => (
        <ParamRow
          key={name}
          name={name}
          spec={params[name]}
          modNames={modNames}
          onChange={partial => updateParam(name, partial)}
        />
      ))}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
        {!presentKeys.includes('vol') && (
          <button onClick={() => addParam('vol')} style={smallBtn}>+ Volume</button>
        )}
        {!presentKeys.includes('rate') && (
          <button onClick={() => addParam('rate')} style={smallBtn}>+ Pitch</button>
        )}
        {missingFilters.map(t => (
          <button key={t} onClick={() => addParam(t)} style={smallBtn}>
            + {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
    </div>
  )
}

function ParamRow({
  name, spec, modNames, onChange,
}: {
  name: string
  spec: ParamSpec
  modNames: string[]
  onChange: (partial: Partial<ParamSpec>) => void
}) {
  const isFilter = (FILTER_TYPES as readonly string[]).includes(name)
  // Filter cutoffs span 20Hz – 20kHz; vol is 0–2; rate is 0.25–4. Pick
  // the slider range that matches what the user expects.
  const range = isFilter ? { min: 20, max: 20000, step: 1 }
    : name === 'vol' ? { min: 0, max: 2, step: 0.01 }
    : name === 'rate' ? { min: 0.25, max: 4, step: 0.01 }
    : { min: 0, max: 2, step: 0.01 }

  // When min+max are both set, the spec acts as a remap (modulator 0..1
  // → min..max). Otherwise base × modulator. UI shows different controls
  // for the two modes.
  const isRemap = spec.min != null && spec.max != null

  const modValue = Array.isArray(spec.modulator) ? spec.modulator.join(',') : (spec.modulator ?? '')

  return (
    <div style={{
      marginBottom: 10,
      padding: 8,
      background: '#141a23',
      borderRadius: 4,
      border: '1px solid #1e242e',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 11 }}>{name}</span>
        <button
          onClick={() => onChange(isRemap ? { min: undefined, max: undefined } : { min: range.min, max: range.max })}
          style={{ ...smallBtn, padding: '2px 6px', fontSize: 9 }}
          title={isRemap ? 'Switch to base×mod mode' : 'Switch to remap min..max mode'}
        >
          {isRemap ? 'mode: remap' : 'mode: base×mod'}
        </button>
      </div>

      {!isRemap && (
        <Slider label="base" value={spec.base ?? 1} min={range.min} max={range.max} step={range.step}
                onChange={v => onChange({ base: v })} />
      )}
      {isRemap && (
        <>
          <Slider label="min" value={spec.min ?? range.min} min={range.min} max={range.max} step={range.step}
                  onChange={v => onChange({ min: v })} />
          <Slider label="max" value={spec.max ?? range.max} min={range.min} max={range.max} step={range.step}
                  onChange={v => onChange({ max: v })} />
        </>
      )}

      <label style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
        <span style={{ opacity: 0.7, display: 'block', marginBottom: 2 }}>modulator</span>
        <select
          value={modValue}
          onChange={e => onChange({ modulator: e.target.value || undefined })}
          style={{
            width: '100%', padding: '3px 6px', fontSize: 11,
            background: '#0e1118', color: '#cfd6e0',
            border: '1px solid #2a323d', borderRadius: 3,
          }}
        >
          <option value="">(none — constant)</option>
          {modNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      {isRemap && (
        <Toggle label="invert (mod=0 → max)" value={spec.invert ?? false}
                onChange={v => onChange({ invert: v || undefined })} />
      )}
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

const smallBtn: React.CSSProperties = {
  padding: '3px 8px',
  background: '#1a2330',
  color: '#cfd6e0',
  border: '1px solid #2a323d',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 10,
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
    const hasOverride = ovr && (ovr.vol != null || ovr.speed != null || ovr.radius != null || ovr.mute)
    const hasParamEdit = editedParamKeys.has(def.key)
    if (!hasOverride && !hasParamEdit) continue
    const baked: LoopDef = { key: def.key, anchor: def.anchor, src: def.src }
    // Param edits — emit the FULL params block as it now stands on
    // audioLive (setLoopParamSpec keeps audioLive in sync). The boot
    // XHR's keyed-merge replaces unchanged entries' params at this key,
    // so emitting verbatim is what we want.
    if (hasParamEdit) {
      baked.params = { ...(def.params ?? {}) }
    }
    // Volume override — multiplied into params.vol.base. If we already
    // emitted params via param edit, the user's edited base is the
    // truth; ovr.vol is layered on top.
    if (ovr?.vol != null) {
      const baseVol = baked.params?.vol?.base ?? def.params?.vol?.base ?? def.vol ?? 1
      baked.params = { ...(baked.params ?? def.params ?? {}), vol: { ...(baked.params?.vol ?? def.params?.vol ?? {}), base: baseVol * ovr.vol } }
    }
    if (ovr?.radius != null) baked.radius = ovr.radius
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
