# Rubic's World — Audio System

End-to-end map of the audio integration. Every behavioural claim cites
`file:line` so you can jump straight from intent to source.

```
                    ┌─────────────────────────────────────────────┐
  registry.json ───►│           audioLive (mutable mirror)        │◄─── audio.json (per-level override, sparse)
                    └─────────────────────────────────────────────┘
                                       │
                              boot-time deep merge
                                       ▼
                    ┌─────────────────────────────────────────────┐
                    │    audioBus  (singleton, src/world/audio)   │
                    │  ┌────────────┬────────────┬────────────┐  │
                    │  │  loops[]   │  events[]  │ modulators │  │
                    │  └────────────┴────────────┴────────────┘  │
                    └─────────────────────────────────────────────┘
                          ▲                              │
        registerAnchor()  │                              │ play() / tick()
        modulator setters │                              ▼
                    ┌─────────────────────────────────────────────┐
                    │     <AudioBus /> R3F component (per-frame)  │
                    │  attachListener · setCameraOrbitSpeed ...   │
                    └─────────────────────────────────────────────┘
                          ▲                              │
                          │ store / WalkControls         │ Web Audio graph
                          │ TileGrid anchor refs         ▼
                    ┌─────────────────────────────────────────────┐
                    │             AudioContext (browser)           │
                    └─────────────────────────────────────────────┘
```

---

## 1. Module map

```
src/world/audio/
  bus.ts             ── AudioBus class + REGISTRY alias    1179 LOC
  audioLive.ts       ── mutable mirror + per-level XHR      103 LOC
  AudioBus.tsx       ── R3F mount; per-frame metric ticks   196 LOC
  registry.json      ── global default registry (9 loops + 6 events)
  triggers.ts        ── Trigger enum + ALL_TRIGGERS list     38 LOC
  lastTriggered.ts   ── zustand store published by play()    31 LOC
  synth.ts           ── 16 procedural voices (osc + noise)  348 LOC
  audioSettings.ts   ── Leva panel bindings                 169 LOC
  AudioPanel.tsx     ── Leva mount in non-editor routes     138 LOC
  audioUiStore.ts    ── reach-sphere visibility toggle       15 LOC
  SoundVisualizer.tsx── live wireframe meters per loop      186 LOC
  sphereProject.ts   ── flat cube-net → sphere CPU project  112 LOC
  subscriptions.ts   ── store-driven trigger plumbing        25 LOC
  khrAudioEmitter.ts ── glb KHR_audio_emitter import        231 LOC

src/AudioEditorRoute.tsx                                   1247 LOC
  └── /edit/levels/<slug>/audio  (split-screen editor)

vite.config.ts:271–402                                       /__audio/* endpoints
```

---

## 2. The data layering

Three layers. Deepest wins. Unchanged entries retain default values.

```
Global default     ← src/world/audio/registry.json:1               (compiled in)
Per-level override ← public/levels/<slug>/audio.json              (sparse, runtime)
Live edits         ← editor mutations on audioLive                (in-memory)
```

| Stage | Mechanism | File:line |
|-------|-----------|-----------|
| Compile-time import of registry | `import registryJson from './registry.json'` | `src/world/audio/audioLive.ts:1` |
| Sync XHR for per-level override | `xhr.open('GET', \`/levels/${slug}/audio.json?t=${Date.now()}\`, false)` | `src/world/audio/audioLive.ts:77` |
| Cache-bust query (P55) | `?t=${Date.now()}` on the same line | `src/world/audio/audioLive.ts:77` |
| Keyed merge (loops[] + events[]) | `mergeKeyed()` shallow-merge with deep recurse on objects | `src/world/audio/audioLive.ts:55–67` |
| Stable mutable reference | `export const audioLive: Registry = _live` | `src/world/audio/audioLive.ts:99` |
| Bus alias | `export const REGISTRY: Registry = audioLive` | `src/world/audio/bus.ts:112` |

**Why an alias and not a re-import:** existing consumers (`audioSettings.ts`,
`AudioPanel.tsx`) keep importing `REGISTRY`. The alias is a pointer to the
same object — editor mutations to `audioLive` are visible to every consumer
on the next iteration without re-registration.

Slug source of truth: `bootLevelSlug` from `src/settings/index.ts`, re-exported
as `audioBootSlug` (`src/world/audio/audioLive.ts:103`).

---

## 3. Registry shape

```ts
interface LoopDef {                                 // src/world/audio/bus.ts:67
  key: string
  anchor: AnchorRef                                 // 'world' | 'camera_motion' | `object:${id}`
  src: string                                       // 'synth:<name>' or 'audio/<file>.ogg'
  adsr?: ADSR                                       // forward-compat (issue #69)
  params?: Record<string, ParamSpec>
  vol?: number                                      // legacy → params.vol on normalize
  modulator?: string | string[]                     // legacy → params.vol.modulator
  refDist?: number; maxDist?: number; rolloff?: number
  radius?: number                                   // shorthand; expands to refDist=0/maxDist=radius/rolloff=1
  envelope?: VolumeEnvelope                         // baked Blender Speaker.volume
  kernel?: KernelSpec                               // Bézier convolution IR (PR #66)
}

interface ParamSpec {                               // src/world/audio/bus.ts:22
  base?: number                                     // base × modulator mode
  modulator?: string | string[]
  min?: number; max?: number; invert?: boolean      // remap mode (modulator 0..1 → min..max)
  q?: number                                        // filter resonance
}

interface EventDef {                                // src/world/audio/bus.ts:95
  key: string
  anchor: AnchorRef
  src: string
  pitchJitter?: number                              // ± playbackRate per play
  gainJitter?: number                               // ± gain per play (Round 1)
  adsr?: ADSR                                       // per-play envelope (Round 1)
  polyphony?: number                                // FIFO voice cap
}

interface ADSR {                                    // src/world/audio/bus.ts:61
  attack: number   // ms
  decay: number    // ms
  sustain: number  // 0..1
  release: number  // ms
}
```

Two binding modes for `ParamSpec` (`src/world/audio/bus.ts:756–765`):
- **base × mod**  — `value = (base ?? 1) * mod`
- **remap** — `value = min + t × (max − min)` where `t = invert ? (1 − mod) : mod`

The `q` field reads on every tick so the editor's resonance slider takes
effect without rebuilding the BiquadFilter (`src/world/audio/bus.ts:807–810`).

---

## 4. Anchors and coordinate spaces

There are TWO scenes with different coordinate systems:

- **main scene** — what the camera sees; orbits at sphere radius.
- **dScene** (diorama scene) — flat 4×6 cube-net coordinates that the GPU folds onto the sphere.

The audio listener lives in main scene (`src/world/audio/AudioBus.tsx:26`), but
diorama sources (car, windmill, pond, birds) live in dScene. Connecting them:

```
dScene COM child ────► CPU project flat→sphere ────► main-scene tracker Object3D
(source position)      cubeNetToSphere()             (PositionalAudio attaches here)
```

| Function | What it does | File:line |
|----------|--------------|-----------|
| `registerAnchor(id, obj)` | Map id → Object3D; resolve pending loops | `src/world/audio/bus.ts:326–332` |
| `registerAnchorAtCenter(id, group)` | Drop a COM child; treat IT as the source | `src/world/audio/bus.ts:344–363` |
| `registerDioramaSource(id, source)` | Source in dScene; tracker in main scene | `src/world/audio/bus.ts:369–380` |
| `attachSphereScene(scene)` | Wire main scene as tracker host | `src/world/audio/bus.ts:397–416` |
| `setDioramaRoot(root)` | Save root for the temp-reset trick | `src/world/audio/bus.ts:420–422` |
| `updateSphereTrackers()` | Per-frame project all sources | `src/world/audio/bus.ts:429–453` |
| `cubeNetToSphere(flat, out)` | Pure CPU mirror of the GPU fold | `src/world/audio/sphereProject.ts` |

The "temp-reset trick" (`bus.ts:432–438`): TileGrid leaves `diorama.root` at
the last-tile transform after rendering, so `getWorldPosition()` would read
garbage. We zero its position/quaternion, project, then restore.

Anchor registration call sites:
- Player anchor — `src/world/WalkControls.tsx`
- Diorama anchors (car/windmill/pond/birds) — `src/diorama/TileGrid.tsx:94–107`
- Scene-origin anchor — `src/world/audio/AudioBus.tsx:65–71`

---

## 5. Modulators — game state → audio params

Modulators are named functions returning a 0..1 value. They're the bridge
between game state and audio params.

| Modulator | Source | Reader |
|-----------|--------|--------|
| `windStrength` | grass shader uWindStrength uniform | `src/world/audio/AudioBus.tsx:54` (setter), `bus.ts:826–830` (read) |
| `cameraOrbitSpeed` | orbit ω in orbit mode, linear v in walk mode | `AudioBus.tsx:84–113`, `bus.ts:832` |
| `sliceRotationActive` | drag||anim → 0/1, smoothed 60ms attack / 350ms release | `bus.ts:729–735`, `bus.ts:833` |
| `themeWalkDuck` | 0.5 in walk, 1.0 in orbit | `AudioBus.tsx:117`, `bus.ts:834` |
| `awayFromPond` | `1 − 0.7 × pondProximity` (cross-fade) | `AudioBus.tsx:123–133`, `bus.ts:835` |
| `grassSwipeIntensity` | TileGrid hover-stamp: cursorOnGrass × cursorSpeed | `TileGrid.tsx:1422`, `bus.ts:836` |
| `carSpeed` | car anchor world Δ / dt, normalised to CAR_SPEED | `AudioBus.tsx:138–151`, `bus.ts:837` |

Custom names register via `audioBus.setModulator(name, fn)`
(`src/world/audio/bus.ts:474–476`). All combine via `combinedModulator()`
which multiplies an array of names (`bus.ts:817–823`).

Listed for the editor by `audioBus.listModulatorNames()` (`bus.ts:480–482`).

---

## 6. The per-frame tick

Driver: `useFrame` in `<AudioBus />` (`src/world/audio/AudioBus.tsx:84`).

```
useFrame((_, dt) => {
  ── compute orbitSpeed from cam motion           AudioBus.tsx:89–113
  ── compute pondProximity                         AudioBus.tsx:123–133
  ── compute carSpeed                              AudioBus.tsx:138–151
  ── update flock centroid in dScene-local        AudioBus.tsx:160–185
  ── audioBus.updateSphereTrackers()              AudioBus.tsx:190 → bus.ts:429
  ── audioBus.tick(dt)                            AudioBus.tsx:192 → bus.ts:724
})
```

Inside `bus.tick(dt)` (`src/world/audio/bus.ts:724–743`):
- Smooth `sliceRotActive` toward `sliceRotActiveTarget` (60ms attack /
  350ms release).
- For every loop runtime: `applyParams(lr)` writes every param's smoothed
  value through `smoothSet()`.

`smoothSet()` (`src/world/audio/bus.ts:134–147`): writes use
`cancelAndHoldAtTime(now)` + `linearRampToValueAtTime(target, now + horizon)`
to avoid zipper noise on rapid drags. Per-param dedupe via WeakMap so
repeating the same target doesn't flood the timeline.

Three horizons: gain (33ms), rate (50ms), filter (40ms). Filter sweeps
audibly chirp if too fast (`bus.ts:130–132`).

---

## 7. The per-loop graph

Two flavours depending on `def.src`:

**Sample loop** — THREE.AudioLoader (cached) → THREE.Audio or THREE.PositionalAudio:

```
ctx.createBufferSource()
  └── setBuffer(buf), setLoop(true)
  └── setFilters([highpass?, bandpass?, lowpass?, kernel?])  ← see §10
  └── setVolume(0); positional.setRefDistance/MaxDistance/RolloffFactor
  └── target.add(positional)            ← target is the anchor Object3D
  └── positional.play()
```

`bus.ts:1037–1085` (sample), `bus.ts:993–1032` (synth path). Filters built
by `buildFiltersForParams()` (`bus.ts:212–228`) — keys `lowpass`/`highpass`/
`bandpass` mapped to BiquadFilters in stable order
`highpass → bandpass → lowpass` (trim bottom, focus middle, trim top).

**Synth loop** — bypass three.js entirely. Source comes from a `SynthLoopHandle`:

```
const handle = SYNTH_LOOPS[name](ctx)   ← oscillators + LFOs + filter chain
  └── 2D path:  handle.source → gain → ambientGain | sfxGain
  └── 3D path:  positional.setNodeSource(handle.source) on anchor target
```

(`bus.ts:993–1032`, `synth.ts:1–348`).

`detachLoopNode()` (`bus.ts:942–972`) handles teardown for re-registration:
brief gain fade, `stop()`, `parent.remove`, null out runtime slots.

---

## 8. The per-play graph (events) — Round 1 ADSR + jitter

```
ctx.createBufferSource()
  ├── playbackRate.value = speedMul × pitchJitter?               bus.ts:697–702
  ├── voiceVol = volMul × gainJitter?                             bus.ts:703–706
  └── connect chain:
       src ──► [adsrGain?] ──► [voiceGain?] ──► sfxGain
                  │               (created when voiceVol≠1)
                  │
                  └── ADSR automation (bus.ts:715–732):
                      g.setValueAtTime(0, now)
                      g.linearRampToValueAtTime(1, now + A)
                      g.linearRampToValueAtTime(S, now + A + D)
                      g.setValueAtTime(S, releaseStart)
                      g.linearRampToValueAtTime(0, releaseStart + R)
                      where releaseStart = max(now+A+D, now + effDur − R)
                      and   effDur = buf.duration / playbackRate
```

Polyphony voice-stealing now ADSR-aware (`bus.ts:686–691` + `releaseAndStop()`
at `bus.ts:773–788`):

```
old voice has ADSR  →  cancelAndHoldAtTime(now)
                       linearRampToValueAtTime(0, now + R)
                       src.stop(now + R)
old voice has none  →  src.stop()  (legacy behaviour)
```

Per-source ADSR sidecar stored in `WeakMap<BufferSourceNode, {gain, releaseSec}>`
(`bus.ts:286–289`).

Polyphony cap (`bus.ts:681–691`): `activeEventSources: Map<key, BufferSourceNode[]>`
— FIFO shift when at the cap, `'ended'` listener prunes the list whether the
voice ended naturally or via `releaseAndStop`.

---

## 9. Triggers — game code → audioBus.play()

Single source of truth: `Trigger` enum (`src/world/audio/triggers.ts:20–33`):

```ts
export const Trigger = {
  Footstep: 'footstep', Jump: 'jump',
  TileSnap: 'tile_snap', Solve: 'solve',
  MenuOpen: 'menu_open', MenuClose: 'menu_close',
} as const
```

Wired call sites:

| Trigger | Where | File:line |
|---------|-------|-----------|
| Footstep | per-step in walk loop | `src/world/WalkControls.tsx:309` |
| Jump | jump start | `src/world/WalkControls.tsx:166` |
| TileSnap | slice 90° commit | `src/world/store.ts:356` |
| Solve | unsolved → solved transition | `src/world/store.ts:358` |
| MenuOpen / MenuClose | pause overlay toggle | `src/world/store.ts:434, 443` |

`play()` flow (`src/world/audio/bus.ts:617–697`):

1. Look up def in `REGISTRY.events` (alias to audioLive).
2. Check `eventOverrides.mute` — silent gate.
3. Publish to `useLastTriggered` zustand store (`bus.ts:626`) so the editor's
   left panel auto-selects the just-fired row.
4. Resume suspended AudioContext (autoplay policy).
5. Synth path or sample path (per `src.startsWith('synth:')`).

`useLastTriggered` (`src/world/audio/lastTriggered.ts`) holds `{ key, n }` —
the editor subscribes to it (`AudioEditorRoute.tsx:170–174`).

---

## 10. The Bézier kernel filter (PR #66)

Convolution IR generated from a cubic Bézier curve: 4 control points
`{p1, cp1, cp2, p2}`, `taps` count, `decay` exponential, `wet` mix.

Loops: convolver joins `setFilters([biquads..., kernelConvolver])` so the
chain is: `source → highpass → bandpass → lowpass → kernel`.
`audioBus.setLoopKernel(key, spec)` re-registers the loop (`bus.ts` —
search `setLoopKernel`).

Events: per-play split. The dry/wet split was added in Round 0:

```
BufferSource → split:
  ├ dry GainNode (gain = 1 − wet) ─────┐
  └ ConvolverNode → wet GainNode ──────┴→ vol-mul gain → sfxGain
```

Editor: `KernelEditor` component in `src/AudioEditorRoute.tsx`. Canvas with
draggable control points. Idempotent — re-registers cleanly on edit.

---

## 11. Volume envelope (Blender authored)

Loops imported from Blender via `KHR_audio_emitter` carry a baked
`Speaker.volume` keyframe envelope (`src/world/audio/khrAudioEmitter.ts`).

```ts
interface VolumeEnvelope {                          // src/world/audio/bus.ts:49
  fps: number
  samples: number[]
}
```

Sampled per tick with linear interpolation + modulo wrap:
`sampleEnvelope()` at `src/world/audio/bus.ts:155–167`. The result multiplies
into the loop's gain alongside the modulator output (`bus.ts:772–774`).

---

## 12. Master / category mute & volume

Three-tier graph:

```
synth + sample event sources ──► sfxGain ────┐
synth ambient sources ──► ambientGain ───────┼──► masterGain ──► ctx.destination
```

Built in `attachListener()` (`bus.ts:309–317`). THREE.Audio /
PositionalAudio loops bypass this graph (they route through the listener
directly), so master mute also slaves `listener.gain.gain`
(`bus.ts:867–868`) — belt and suspenders.

Setters write through `applyGraphGains()` + `applyAllVolumes()`
(`bus.ts:854–873`).

Categorisation (`bus.ts:842–845`): `ambient_*` and `wind_cutting` route
through ambientGain; everything else through sfxGain.

---

## 13. Per-sound user overrides

Live multipliers on top of the registry base. Stored in two maps
(`bus.ts:261–262`):

```ts
loopOverrides:  Map<string, { vol?, speed?, mute?, radius? }>
eventOverrides: Map<string, { vol?, speed?, mute? }>
```

Speed and radius push to live nodes immediately
(`setLoopOverride` at `bus.ts:546–560`). Volume folds into the next tick's
`applyParams` (`bus.ts:766–782`). Mute forces gain to 0.

UI surface: Leva panel via `audioSettings.ts` + `AudioPanel.tsx`.

---

## 14. Vite dev endpoints

Three middlewares for editor commits (`vite.config.ts`):

| Endpoint | Purpose | Range |
|----------|---------|-------|
| `POST /__audio/commit?level=<slug>` | Write `public/levels/<slug>/audio.json` | `vite.config.ts:271–306` |
| `POST /__audio/peaks?src=<path>` | Write `<src>.peaks.json` sidecar | `vite.config.ts:308–348` |
| `POST /__audio/upload?level=<slug>&filename=<n>` | Content-hashed sample upload | `vite.config.ts:350–400` |

Slug is whitelisted via `levelGlbPath()`. Peaks sidecars are
gitignored. Upload returns the registry-shape `src` for direct assignment.

P46 lesson: assets fetch with leading slash. `loadBuffer()` normalises
`'audio/foo.ogg'` to `'/audio/foo.ogg'` before fetch
(`bus.ts:707–720`) so the editor works under `/optimize/`, `/edit/`, etc.

---

## 15. The audio editor

Route: `/edit/levels/<slug>/audio` → `AudioEditorRoute` in
`src/AudioEditorRoute.tsx:65`.

Layout (hand-rolled splitter, ~30 LOC, persists width to localStorage,
writes `--audio-editor-canvas-left` CSS var):

```
┌───────────────────────────────────┬──────────────────────────────┐
│        AudioWorkspace             │                              │
│  ┌─────────────────────────────┐  │      <App route="audio-edit" │
│  │ Header: slug + ForceTrigger │  │       />  with Canvas pinned │
│  │       + Commit Audio        │  │       to the right of split  │
│  ├─────────────────────────────┤  │                              │
│  │ EventList (loops + events)  │  │                              │
│  ├─────────────────────────────┤  │                              │
│  │ Inspector                   │  │                              │
│  │   ├ WaveformCanvas          │  │                              │
│  │   ├ SampleSwap              │  │                              │
│  │   ├ Loop: Overrides + Params│  │                              │
│  │   ├ Loop: KernelEditor      │  │                              │
│  │   ├ Event: Overrides        │  │                              │
│  │   ├ Event: PitchJitter      │  │                              │
│  │   ├ Event: GainJitter       │  │ Round 1                      │
│  │   ├ Event: ADSREnvelope     │  │ Round 1                      │
│  │   └ Event: KernelEditor     │  │                              │
│  └─────────────────────────────┘  │                              │
└───────────────────────────────────┴──────────────────────────────┘
  split-bar drag-resize, persists in localStorage 'rubicsworld:audioEditorSplit'
```

Components and responsibilities:

| Component | Responsibility | File:line |
|-----------|----------------|-----------|
| `AudioEditorRoute` | Splitter + workspace + R3F canvas | `AudioEditorRoute.tsx:65–137` |
| `AudioWorkspace` | Reactive snapshot of audioLive (500ms ticker) | `AudioEditorRoute.tsx:145–256` |
| `ForceTrigger` | Dropdown for any Trigger (forces .play) | `AudioEditorRoute.tsx:267–290` |
| `EventList` | Loops + events list, auto-select on lastTriggered | `AudioEditorRoute.tsx:294–386` |
| `Inspector` | Renders SampleSwap + WaveformCanvas + Overrides | `AudioEditorRoute.tsx:390–415` |
| `WaveformCanvas` | Peaks sidecar fetch / generate + canvas render | `AudioEditorRoute.tsx:491–586` |
| `SampleSwap` | File picker → /__audio/upload → registerLoop | `AudioEditorRoute.tsx:770–829` |
| `LoopOverrides` | Vol/speed/radius/mute sliders | `AudioEditorRoute.tsx:831–848` |
| `ParamsEditor` | Modulator + min/max + filter Q + add filter | `AudioEditorRoute.tsx:604–678` |
| `EventOverrides` | Vol/speed/mute + polyphony + jitter + ADSR | `AudioEditorRoute.tsx:854–905` |
| `ADSREnvelopeEditor` | 200×80 canvas + 4 handles + 4 sliders (Round 1) | `AudioEditorRoute.tsx:932–1100` |
| `KernelEditor` | Bézier IR canvas + control points | `AudioEditorRoute.tsx` (search) |

The 500ms ticker in `AudioWorkspace` (`AudioEditorRoute.tsx:150–153`) is the
simplest reactivity layer over `audioLive`'s direct mutations — bus and
editor both write to the same object; ticker flushes the React tree.

`buildSparseAudioJson()` (`AudioEditorRoute.tsx:1235–1247` for events)
emits only entries where overrides or persistent fields were touched. Two
edited-key sets (`editedParamKeys`, `editedEventKeys`) flag entries for
emission. Boot XHR's keyed merge (`audioLive.ts:55`) replaces matching
entries in audioLive on reload.

---

## 16. Lifecycle — boot to teardown

```
1. settings/index.ts boots, resolves bootLevelSlug from URL
2. audioLive.ts top-of-module IIFE:
     ├── deepClone(registryJson) into _live
     └── if (slug) sync XHR `/levels/<slug>/audio.json` and merge

3. App mounts → <Canvas><AudioBus />…
4. AudioBus mount effect (StrictMode-safe via parent === camera guard):
     ├── audioBus.attachListener(camera)         bus.ts:302–318
     │     └── builds masterGain/ambientGain/sfxGain
     │     └── bootLoops() — attach every loop  bus.ts:974–981
     ├── audioBus.attachSphereScene(scene)       bus.ts:397
     ├── installAudioSubscriptions()             subscriptions.ts:15
     ├── unlock pointerdown/keydown listeners    AudioBus.tsx:33–40
     ├── visibilitychange suspend/resume         AudioBus.tsx:44–50
     └── setWindStrengthSource()                 AudioBus.tsx:54

5. Diorama renders → TileGrid registers anchors:
     audioBus.registerAnchorAtCenter('car', …)   TileGrid.tsx:94
     audioBus.setDioramaRoot(root)               (lifecycle)

6. Per frame:
     useFrame → metric ticks → updateSphereTrackers → tick(dt)

7. Game events:
     audioBus.play(Trigger.Footstep) etc.

8. Tab hidden → ctx.suspend; tab visible → ctx.resume
9. Listener never detached on unmount (StrictMode safety)
```

---

## 17. Round 1 (this PR) — what changed

PR #68, branch `feat/audio-adsr`, closes #67.

### 17a. Schema (src/world/audio/bus.ts)

```ts
// new
interface ADSR { attack: number; decay: number; sustain: number; release: number }
                                                          // bus.ts:61
LoopDef.adsr?: ADSR                                       // bus.ts:72 (forward-compat)
EventDef.gainJitter?: number                              // bus.ts:102
EventDef.adsr?: ADSR                                      // bus.ts:106
```

### 17b. Per-source ADSR sidecar (src/world/audio/bus.ts:286–289)

```ts
private eventAdsrInfo = new WeakMap<AudioBufferSourceNode, { gain: GainNode; releaseSec: number }>()
```

### 17c. Per-play ADSR + gainJitter graph (src/world/audio/bus.ts:681–745)

- `voiceVol = volMul × (1 ± gainJitter)`            (bus.ts:703–706)
- `adsrGain` inserted only when `def.adsr` is set    (bus.ts:713)
- 4-segment automation curve                         (bus.ts:715–731)
- Sidecar stored on `eventAdsrInfo`                  (bus.ts:732)
- Voice graph: `src → [adsrGain?] → [voiceGain?] → sfxGain`  (bus.ts:741–745)

### 17d. ADSR-aware voice stealing (src/world/audio/bus.ts:773–788)

```ts
private releaseAndStop(src: AudioBufferSourceNode) {
  const info = this.eventAdsrInfo.get(src)
  if (!info || !ctx) { src.stop(); return }            // legacy fallback
  // cancelAndHoldAtTime → ramp to 0 → defer src.stop(now + R)
}
```

Replaces the old immediate `src.stop()` in the polyphony loop (`bus.ts:686–691`).

### 17e. Editor — ADSREnvelopeEditor (src/AudioEditorRoute.tsx:907–1100)

200×80 canvas, 4 draggable handles:

```
y = 1 ┤ ●─.                   <-- handle 0 (attack-end, x = attack ms, y locked at 1)
      │  / `─●─────●          <-- handle 1 (decay-end), handle 2 (hold-end, sustain level)
      │ /        \
      │/          `●          <-- handle 3 (release-end, vertical drag controls release)
y = 0 ┴────────────
      | A | D |  HOLD  |  R  |
```

Hold zone is fixed at `ADSR_MAX_AD_MS = 2000ms` of canvas width to keep
the sustain handle visible. It's NOT a real sustain duration — sustain
length depends on `effDur − A − D − R` at play time.

4 raw sliders below the canvas mirror the handles:
- attack (1–2000 ms), decay (0–2000 ms), sustain (0–1), release (1–4000 ms).

`enable` / `disable` button toggles `adsr` between `undefined` and a
sensible default (`{ attack: 5, decay: 50, sustain: 0.8, release: 80 }`).

### 17f. EventOverrides additions (src/AudioEditorRoute.tsx:854–905)

```tsx
// only for sample-backed events (synth voices manage their own envelope)
{!isSynth && (
  <>
    <Slider label="Pitch jitter" ... />
    <Slider label="Gain jitter"  ... />
    <ADSREnvelopeEditor adsr={entry.adsr} onChange={setAdsr} />
  </>
)}
```

`entry.pitchJitter`, `entry.gainJitter`, `entry.adsr` are mutated
directly on the `audioLive` entry. `play()` reads `def` each call so
edits surface on the next trigger without a registerEvent equivalent.

### 17g. buildSparseAudioJson emit (src/AudioEditorRoute.tsx:1235–1247)

```ts
if (def.pitchJitter != null) baked.pitchJitter = def.pitchJitter
if (def.gainJitter  != null) baked.gainJitter  = def.gainJitter
if (def.polyphony   != null) baked.polyphony   = def.polyphony
if (def.adsr) baked.adsr = { ...def.adsr }
```

---

## 18. Known gaps and follow-ups

| Issue | Title | Source |
|-------|-------|--------|
| #69 | LoopDef.adsr is dead schema (wire with #60 crossfade or strip) | Round 1 self-review |
| #70 | ADSR release can tail past buffer end on absurd values | Round 1 self-review |
| #71 | `releaseAndStop` name ambiguous when ADSR absent | Round 1 self-review |
| #72 | Per-play graph allocates extra GainNode under ADSR + voiceVol | Round 1 self-review |
| #56 | Multi-instrument (sample variation pool) — Round 5 | Roadmap |
| #58–#62 | Phase C runtime reactivity + scramble override | Roadmap |
| #60 | Audio crossfade on level swap — Round 3 follow-up | Roadmap |
| #63 | Author lvl_2..5 in Blender | Out of scope |

Roadmap rounds:

- **Round 2** — 3-band EQ block + frequency-response preview
- **Round 3** — Reverb send + per-level room IR upload
- **Round 4** — Attenuation curves with distance-driven LPF/HPF
- **Round 5** — Goal categorization (cue/feedback/emotion) + sample variation pool + loop-point handles + tail extender

---

## 19. Live URLs

- Editor: `http://localhost:5173/edit/levels/lvl_1/audio`
- Game: `http://localhost:5173/game/`
- Per-level dev playground: `http://localhost:5173/edit/levels/lvl_1/?glb=1`

---

## 20. Quick reference — common operations

**Add a new SFX trigger:**

1. `Trigger.MyId = 'my_id'` in `src/world/audio/triggers.ts:20`
2. Add `events[]` row in `src/world/audio/registry.json` (or per-level)
3. Call `audioBus.play(Trigger.MyId)` from game code

**Add a new modulator:**

1. Add backing state field on AudioBus class (`bus.ts`)
2. Add public setter
3. Add a branch in `modulatorValue()` (`bus.ts:825–840`)
4. Drive the setter from `AudioBus.tsx`'s `useFrame`

**Author a new positional loop:**

1. Add `loops[]` row with `anchor: "object:my_anchor"`, `radius`, `params`
2. Register the anchor: `audioBus.registerAnchor('my_anchor', obj3d)`
   or `registerAnchorAtCenter(group)` for a group's COM
3. If it's a diorama (dScene) source, anchor flows through sphere
   tracker automatically; nothing else needed.

**Edit a sound at runtime:**

1. Open `/edit/levels/<slug>/audio`
2. Click the entry; tweak the inspector
3. Click `Commit Audio` → POST writes `public/levels/<slug>/audio.json`
4. Reload — boot XHR picks up the override

**Add ADSR to a sample event:**

1. Open editor, click event, click `enable` in the ADSR section
2. Drag handles or use sliders below
3. Audition with the `▶ Audition` button or trigger from game
4. Commit
