import { create } from 'zustand'
import { buildSolvedTiles, isSolved, type Tile } from './tile'
import { rotateSlice, randomMove, inverseMove, type Axis, type Direction, type Move } from './rotation'
import type { FaceIndex } from './faces'
import { audioBus } from './audio/bus'
import { Trigger } from './audio/triggers'
import { PLANETS, getPlanet, getNextPlanet } from './planetManifest'

// localStorage keys for the menu/jam-route persistence layer. TutorialOverlay
// also writes 'rubicsworld:tutorialSeen' from its own copy of the literal —
// the constant is duplicated rather than shared because resetProgress() is
// the only consumer here and the overlay has no other store-coupling reason
// to import from store.
const TUTORIAL_SEEN_KEY = 'rubicsworld:tutorialSeen'
const AUDIO_MUTED_KEY = 'rubicsworld:audioMuted'
const PROGRESS_KEY = 'rubicsworld:progress'
const PREFS_KEY = 'rubicsworld:preferences'

// User-pickable level of three for difficulty + visuals. Difficulty maps
// to scramble move count (read by IntroCinematic on each level boot).
// Visuals is a placeholder rung — wired through the panel UI but no
// renderer flag consumes it yet (Phase C territory).
export type Tier = 'low' | 'medium' | 'high'

interface PersistedPrefs {
  difficulty: Tier
  visuals: Tier
  masterVolume: number  // [0..1]
  sfxVolume: number     // [0..1]
}

const DEFAULT_PREFS: PersistedPrefs = {
  difficulty: 'medium',
  visuals: 'high',
  masterVolume: 1,
  sfxVolume: 1,
}

function readPersistedPrefs(): PersistedPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS }
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<PersistedPrefs>
    return {
      difficulty: isTier(parsed.difficulty) ? parsed.difficulty : DEFAULT_PREFS.difficulty,
      visuals:    isTier(parsed.visuals)    ? parsed.visuals    : DEFAULT_PREFS.visuals,
      masterVolume: clampVol(parsed.masterVolume, DEFAULT_PREFS.masterVolume),
      sfxVolume:    clampVol(parsed.sfxVolume,    DEFAULT_PREFS.sfxVolume),
    }
  } catch { return { ...DEFAULT_PREFS } }
}

function writePersistedPrefs(p: PersistedPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

function isTier(v: unknown): v is Tier { return v === 'low' || v === 'medium' || v === 'high' }
function clampVol(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(1, Math.max(0, v))
}

/** Difficulty → number of scramble moves applied at level boot. Spans
 *  the 3..8 range the spec calls for: easy enough to teach the
 *  rotation moves at LOW, challenging at HIGH. Read by IntroCinematic
 *  via a getter so a preference change between levels takes effect on
 *  the next boot without component churn. */
export function scrambleCountFor(t: Tier): number {
  return t === 'low' ? 3 : t === 'high' ? 8 : 5
}

interface PersistedProgress {
  currentPlanetSlug: string
  solvedPlanets: string[]
}

function readPersistedProgress(): PersistedProgress {
  const fallback: PersistedProgress = {
    currentPlanetSlug: PLANETS[0]!.slug,
    solvedPlanets: [],
  }
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(PROGRESS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedProgress>
    if (
      typeof parsed.currentPlanetSlug !== 'string' ||
      !Array.isArray(parsed.solvedPlanets) ||
      !getPlanet(parsed.currentPlanetSlug)
    ) {
      return fallback
    }
    // Filter out stale slugs from the solved list (e.g. older slug names that
    // no longer exist in the manifest after a rename).
    const cleaned = parsed.solvedPlanets.filter(s => typeof s === 'string' && getPlanet(s))
    return { currentPlanetSlug: parsed.currentPlanetSlug, solvedPlanets: cleaned }
  } catch {
    return fallback
  }
}

function writePersistedProgress(p: PersistedProgress) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

// One-shot flag set by selectLevel / advancePlanet right before they call
// window.location.reload() — boot reads it once and resumes at gamePhase
// 'playing' instead of dropping back to the title screen. The reload is
// what re-seeds module-scope consumers (hdriStore, grassUniforms,
// postfxLive) from the NEW level's settings.json — they don't react to
// runtime slug changes, so without this an in-session selectLevel left
// the previous level's HDRI / grass / postfx in place. Cleared after
// it's read so a subsequent natural refresh starts at title.
const AUTOSTART_KEY = 'rubicsworld:autoStart'
function readAutoStart(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    if (localStorage.getItem(AUTOSTART_KEY) !== '1') return false
    localStorage.removeItem(AUTOSTART_KEY)
    return true
  } catch { return false }
}
function reloadIntoLevel(slug: string, solvedPlanets: string[]): never {
  writePersistedProgress({ currentPlanetSlug: slug, solvedPlanets })
  try { localStorage.setItem(AUTOSTART_KEY, '1') } catch { /* ignore */ }
  if (typeof window !== 'undefined') window.location.reload()
  // Throw to unwind the set() — should never reach here unless tests
  // stub `window`. Cast keeps the call site's `set(s => ...)` type-safe.
  throw new Error('reloadIntoLevel: window.location.reload returned')
}

function readPersistedMute(): boolean {
  try {
    return typeof localStorage !== 'undefined' &&
      localStorage.getItem(AUDIO_MUTED_KEY) === '1'
  } catch {
    return false
  }
}

/** Which tile the cursor is over, in current cube coordinates. Drives the
 *  hover-to-key rotation hybrid: hover a tile, press Q/W/E/A/S/D → rotate the
 *  slice containing it around a face-local axis. Set by Interaction.tsx on
 *  pointermove raycasts; null when the cursor is off the planet. */
export interface HoveredTile {
  face: FaceIndex
  u: number
  v: number
}

export interface AnimState {
  id: number
  axis: Axis
  slice: number
  from: number
  to: number
  commitDir: Direction | 0 // 0 = snap back (no commit), otherwise commit direction
}

export interface DragState {
  axis: Axis
  slice: number
  angle: number
}

interface PlanetStore {
  tiles: Tile[]
  solved: boolean
  anim: AnimState | null
  drag: DragState | null
  showLabels: boolean
  showRing: boolean
  showAxes: boolean
  onPlanet: boolean
  hoveredTile: HoveredTile | null
  /** 'title' = start screen + Begin gate; planet shows solved with attract
   *  orbit but IntroCinematic is unmounted (gated in App.tsx on the game
   *  route). Flips to 'playing' on Begin click, which mounts IntroCinematic
   *  and runs the existing scramble/tutorial flow. Read by App.tsx; only
   *  meaningful on /game/ — the dev route ignores it. */
  gamePhase: 'title' | 'playing'
  /** In-game pause overlay. Independent of gamePhase — the title screen IS
   *  its own menu, this is the overlay shown via Esc while playing. Opening
   *  it forces cameraMode→'orbit' so the cursor is free for the overlay. */
  menuOpen: boolean
  /** Sequential progression — issue #48. Slug of the planet currently being
   *  played; localStorage-persisted so a refresh resumes the same planet.
   *  Always points at a valid manifest entry (validated on read). */
  currentPlanetSlug: string
  /** Slugs the player has solved, in order. localStorage-persisted. Used by
   *  StatsOverlay to gate the "Continue" button vs end-of-game. */
  solvedPlanets: string[]
  /** performance.now() at the moment gamePhase flipped to 'playing'. Drives
   *  the timer shown in StatsOverlay on solve. Null while on title or after
   *  the post-solve overlay has consumed it. NOT persisted — refresh resets
   *  the run timer (a finished run is the unit, not wall-clock continuity). */
  playStartedAt: number | null
  /** ms elapsed between playStartedAt and the markSolved call. Snapshotted
   *  into store so StatsOverlay reads a stable value while it's open. */
  lastSolveTimeMs: number | null
  /** Post-solve overlay visibility. Mirrors menuOpen's pattern (independent
   *  of gamePhase). Set true by markSolved, cleared by closeStatsOverlay /
   *  advancePlanet. */
  statsOverlayOpen: boolean
  /** Persisted to localStorage; bound to audioBus.setMasterMute on every
   *  setAudioMuted call AND once at module load below. */
  audioMuted: boolean
  /** User preferences — difficulty (scramble count), visuals (placeholder),
   *  audio volumes. Persisted under PREFS_KEY as a single JSON blob. */
  difficulty: Tier
  visuals: Tier
  masterVolume: number
  sfxVolume: number
  /** True at t=0 (HUD covers entire planet as a tutorial attract). Flips
   *  to false on the first successful player commit. TileGrid's useFrame
   *  reads this and eases the shader's uHudOpacity uniform 1→0. */
  hudAttractMode: boolean
  /** Easy mode toggles per-edge correctness colors in the HUD overlay
   *  (green = both tiles at home across this edge, red = misplaced). */
  easyMode: boolean
  /** 'orbit' = third-person outside the planet (default — OrbitControls).
   *  'walk'  = first-person on the surface, mouse-look + WASD.
   *  Input gates (slice-rotation keys, drag-to-rotate) check this. */
  cameraMode: 'orbit' | 'walk'
  /** Attract-mode cinematic on page load. Sequence:
   *    'orbit-solved'    — solved planet slow-orbits (first 3 s)
   *    'scrambling'      — animated scramble playing
   *    'orbit-scrambled' — scramble done, still slow-orbiting, waiting for hover
   *    'tutorial'        — first-visit only; overlay guides a 3-move solve
   *    'done'            — player engaged; camera + input yield to them
   *  Auto-orbit is enabled in 'orbit-solved' / 'scrambling' / 'orbit-scrambled'
   *  and disabled in 'tutorial' / 'done' so the user can target tiles. */
  introPhase: 'orbit-solved' | 'scrambling' | 'orbit-scrambled' | 'tutorial' | 'done'
  /** Visual grade for the scene. 'stylized' = the current low-poly test
   *  diorama — uses the Path-1 pmndrs effect stack only. 'photoreal' = the
   *  upcoming Blender PBR diorama — Path-2 will layer realism-effects
   *  (SSGI / TRAA / motion blur) on top when the asset lands. Gate added
   *  now so Path 2 is a drop-in switch, not a PostFx rewrite. */
  sceneGrade: 'stylized' | 'photoreal'
  /** While in 'tutorial' phase, the ordered list of moves the user must commit
   *  to reach solved. Rebuilt on mismatch via a shortest-path BFS. */
  tutorialQueue: Move[]
  /** Index into tutorialQueue — the next move the overlay is hinting. */
  tutorialStep: number
  commitThreshold: number // radians; drag past this and release → commit
  aiEnabled: boolean
  aiHasFired: boolean // per-playthrough latch; resets on scramble/reset
  lastPlayerActionAt: number // ms timestamp of last committed player rotation
  history: Move[] // moves applied since last reset/solve — replayed in reverse by solveAnimated

  setShowLabels: (v: boolean) => void
  setShowRing: (v: boolean) => void
  setShowAxes: (v: boolean) => void
  setOnPlanet: (v: boolean) => void
  setHoveredTile: (t: HoveredTile | null) => void
  setEasyMode: (v: boolean) => void
  setGamePhase: (v: 'title' | 'playing') => void
  setMenuOpen: (v: boolean) => void
  toggleMenu: () => void
  setAudioMuted: (v: boolean) => void
  setDifficulty: (v: Tier) => void
  setVisuals: (v: Tier) => void
  setMasterVolume: (v: number) => void
  setSfxVolume: (v: number) => void
  /** Mark the given slug solved + open the stats overlay + snapshot the
   *  elapsed time. Idempotent: re-calling for an already-solved slug does
   *  nothing (the overlay can re-open via gamePhase transitions). */
  markSolved: (slug: string) => void
  /** Hide the stats overlay without advancing. Currently unused by UI but
   *  kept for future "stats peek" affordances. */
  closeStatsOverlay: () => void
  /** Pick the next planet via getNextPlanet, swap currentPlanetSlug, reset
   *  the puzzle to a fresh attract state, restart the run timer. If there
   *  is no next planet (end of progression), wipes solvedPlanets and falls
   *  back to title — placeholder UX until the credits flow lands. */
  advancePlanet: () => void
  /** Jump directly to a specific planet by slug — used by the title screen's
   *  "Select level" roster. Like advancePlanet but driven by user pick
   *  rather than progression order. Resets the puzzle, starts the run
   *  timer, kicks gamePhase → 'playing'. No-op if slug is unknown. */
  selectLevel: (slug: string) => void
  /** Wipe localStorage flags (tutorial-seen, audio-muted) and reset
   *  in-memory mute to fresh-install default. Does NOT reload the page —
   *  caller is responsible for follow-up nav (e.g. returnToTitle). */
  resetProgress: () => void
  /** From in-game → back to title screen. Clears scramble, drops to
   *  'orbit-solved' attract, closes menu, exits walk. IntroCinematic
   *  unmounts (gated on gamePhase==='playing' in App.tsx) so the next
   *  Begin click runs a fresh first-mount cinematic. */
  returnToTitle: () => void
  setCameraMode: (v: 'orbit' | 'walk') => void
  setIntroPhase: (v: PlanetStore['introPhase']) => void
  setSceneGrade: (v: PlanetStore['sceneGrade']) => void
  setTutorialQueue: (q: Move[]) => void
  setTutorialStep: (n: number) => void
  setCommitThreshold: (v: number) => void
  setAiEnabled: (v: boolean) => void
  markAiFired: () => void

  beginDragAt: (axis: Axis, slice: number) => void
  updateDrag: (angle: number) => void
  endDrag: () => Promise<void>

  rotateAnimated: (m: Move) => Promise<void>
  rotateInstant: (m: Move) => void
  reset: () => void
  solve: () => void
  solveAnimated: () => Promise<void>
  scrambleInstant: (n?: number) => void
  scrambleAnimated: (n?: number) => Promise<void>

  _finishAnim: () => void
}

function makeScrambledTiles(n: number): { tiles: Tile[]; moves: Move[] } {
  let tiles = buildSolvedTiles()
  let prev: Move | undefined
  const moves: Move[] = []
  for (let i = 0; i < n; i++) {
    const m = randomMove(Math.random, prev)
    tiles = rotateSlice(tiles, m.axis, m.slice, m.dir)
    moves.push(m)
    prev = m
  }
  return { tiles, moves }
}

// Start in solved state so the intro cinematic can show the intact planet
// slow-orbiting for ~3 s, then play an animated scramble. IntroCinematic
// drives that sequence; end-user scramble/reset paths are unchanged.
const initialTiles = buildSolvedTiles()
const initialProgress = readPersistedProgress()
// Read the autoStart flag exactly once at module init — the readAutoStart
// helper consumes the flag (clears localStorage), so calling it twice
// would return false the second time. Both gamePhase and playStartedAt
// below depend on this single decision.
const _bootAutoStart = readAutoStart()
const _bootPrefs = readPersistedPrefs()

let animCounter = 0
let animResolver: (() => void) | null = null

function applyRotation(
  s: Pick<PlanetStore, 'tiles' | 'solved' | 'history' | 'hudAttractMode'>,
  axis: Axis,
  slice: number,
  dir: Direction,
) {
  const newTiles = rotateSlice(s.tiles, axis, slice, dir)
  const nowSolved = isSolved(newTiles)
  // Tile snap — fires every commit (one per gesture). Solve fires only
  // on the unsolved → solved transition. audioBus handles the dev-mode
  // "no listener yet" case internally; safe to call from any thread.
  audioBus.play(Trigger.TileSnap)
  if (!s.solved && nowSolved) {
    audioBus.play(Trigger.Solve)
    window.dispatchEvent(new CustomEvent('planet:settled'))
  }
  return {
    tiles: newTiles,
    solved: nowSolved,
    history: [...s.history, { axis, slice, dir }],
    // First player commit retires attract mode. TileGrid eases the shader
    // uniform from 1 → 0 over ~1 s.
    hudAttractMode: s.hudAttractMode ? false : s.hudAttractMode,
  }
}

export const usePlanet = create<PlanetStore>((set, get) => ({
  tiles: initialTiles,
  solved: true,
  anim: null,
  drag: null,
  showLabels: false,
  showRing: false,
  showAxes: false,
  onPlanet: false,
  hoveredTile: null,
  hudAttractMode: true,
  easyMode: false,
  cameraMode: 'orbit',
  introPhase: 'orbit-solved',
  // gamePhase resumes at 'playing' on the page-reload-after-selectLevel
  // path so the level pick doesn't dump the user back at the title screen
  // (the reload is needed to re-seed HDRI / grass / postfx consumers
  // from the new slug's settings.json — see reloadIntoLevel above).
  // Capture the autoStart decision once so playStartedAt below stays in
  // sync — without the timer stamp here, the post-reload session would
  // boot directly into 'playing' with playStartedAt=null and markSolved
  // would compute elapsed=0 (visible as 00:00 in StatsOverlay).
  gamePhase: ((): 'title' | 'playing' => (_bootAutoStart ? 'playing' : 'title'))(),
  menuOpen: false,
  currentPlanetSlug: initialProgress.currentPlanetSlug,
  solvedPlanets: initialProgress.solvedPlanets,
  playStartedAt: _bootAutoStart ? performance.now() : null,
  lastSolveTimeMs: null,
  statsOverlayOpen: false,
  audioMuted: readPersistedMute(),
  difficulty:   _bootPrefs.difficulty,
  visuals:      _bootPrefs.visuals,
  masterVolume: _bootPrefs.masterVolume,
  sfxVolume:    _bootPrefs.sfxVolume,
  sceneGrade: 'stylized',
  tutorialQueue: [],
  tutorialStep: 0,
  commitThreshold: (6.5 * Math.PI) / 180, // 6.5° — tuned for a light digital feel
  aiEnabled: true,
  aiHasFired: false,
  lastPlayerActionAt: typeof performance !== 'undefined' ? performance.now() : 0,
  history: [],

  setShowLabels: v => set({ showLabels: v }),
  setShowRing: v => set({ showRing: v }),
  setShowAxes: v => set({ showAxes: v }),
  setOnPlanet: v => set(s => (s.onPlanet === v ? {} : { onPlanet: v })),
  setEasyMode: v => set({ easyMode: v }),
  setCameraMode: v => set(s => (s.cameraMode === v ? {} : { cameraMode: v })),
  setGamePhase: v => set(s => {
    if (s.gamePhase === v) return {}
    if (v === 'playing') {
      // Stamp the run timer when leaving the title screen. Pre-existing flow:
      // Begin click → setGamePhase('playing') → IntroCinematic mounts and the
      // scramble/tutorial sequence runs. Timer counts that time as part of
      // the run (per issue #48 proposal); refine to first-rotation later if
      // play-test feedback wants a tighter "active solve" measure.
      return { gamePhase: v, playStartedAt: performance.now(), lastSolveTimeMs: null }
    }
    return { gamePhase: v, playStartedAt: null }
  }),
  setMenuOpen: v => set(s => {
    if (s.menuOpen === v) return {}
    audioBus.play(v ? Trigger.MenuOpen : Trigger.MenuClose)
    // Opening the menu while in walk forces orbit so the cursor is free for
    // the overlay. Closing the menu does NOT auto-restore walk — player
    // re-enters via Tab if they want.
    if (v && s.cameraMode === 'walk') return { menuOpen: true, cameraMode: 'orbit' as const }
    return { menuOpen: v }
  }),
  toggleMenu: () => set(s => {
    const next = !s.menuOpen
    audioBus.play(next ? Trigger.MenuOpen : Trigger.MenuClose)
    if (next && s.cameraMode === 'walk') return { menuOpen: true, cameraMode: 'orbit' as const }
    return { menuOpen: next }
  }),
  setAudioMuted: v => {
    audioBus.setMasterMute(v)
    try { localStorage.setItem(AUDIO_MUTED_KEY, v ? '1' : '0') } catch { /* ignore */ }
    set({ audioMuted: v })
  },
  setDifficulty: v => set(s => {
    if (s.difficulty === v) return {}
    writePersistedPrefs({ difficulty: v, visuals: s.visuals, masterVolume: s.masterVolume, sfxVolume: s.sfxVolume })
    return { difficulty: v }
  }),
  setVisuals: v => set(s => {
    if (s.visuals === v) return {}
    writePersistedPrefs({ difficulty: s.difficulty, visuals: v, masterVolume: s.masterVolume, sfxVolume: s.sfxVolume })
    return { visuals: v }
  }),
  setMasterVolume: v => {
    const clamped = Math.min(1, Math.max(0, v))
    audioBus.setMasterVolume(clamped)
    set(s => {
      writePersistedPrefs({ difficulty: s.difficulty, visuals: s.visuals, masterVolume: clamped, sfxVolume: s.sfxVolume })
      return { masterVolume: clamped }
    })
  },
  setSfxVolume: v => {
    const clamped = Math.min(1, Math.max(0, v))
    audioBus.setCategoryVolume('sfx', clamped)
    set(s => {
      writePersistedPrefs({ difficulty: s.difficulty, visuals: s.visuals, masterVolume: s.masterVolume, sfxVolume: clamped })
      return { sfxVolume: clamped }
    })
  },
  markSolved: slug => set(s => {
    if (s.solvedPlanets.includes(slug)) return {}
    const elapsed = s.playStartedAt != null ? performance.now() - s.playStartedAt : 0
    const nextSolved = [...s.solvedPlanets, slug]
    writePersistedProgress({ currentPlanetSlug: s.currentPlanetSlug, solvedPlanets: nextSolved })
    return {
      solvedPlanets: nextSolved,
      lastSolveTimeMs: elapsed,
      statsOverlayOpen: true,
    }
  }),
  closeStatsOverlay: () => set(s => (s.statsOverlayOpen ? { statsOverlayOpen: false } : {})),
  advancePlanet: () => set(s => {
    const next = getNextPlanet(s.currentPlanetSlug)
    // Shared reset shape — both the next-planet and end-of-progression paths
    // need to drop the puzzle back into a fresh attract state.
    const puzzleReset = {
      tiles: buildSolvedTiles(),
      solved: true,
      anim: null,
      drag: null,
      history: [] as Move[],
      hudAttractMode: true,
      introPhase: 'orbit-solved' as const,
      aiHasFired: false,
      lastPlayerActionAt: performance.now(),
      menuOpen: false,
      cameraMode: 'orbit' as const,
      statsOverlayOpen: false,
      lastSolveTimeMs: null,
    }
    if (!next) {
      // End of progression — placeholder UX: wipe solved list, return to
      // title. Replace with a credits / replay flow once authored.
      writePersistedProgress({ currentPlanetSlug: PLANETS[0]!.slug, solvedPlanets: [] })
      return {
        ...puzzleReset,
        currentPlanetSlug: PLANETS[0]!.slug,
        solvedPlanets: [],
        playStartedAt: null,
        gamePhase: 'title' as const,
      }
    }
    // Continue button: reload so HDRI / grass / postfx re-seed from the
    // new level's settings.json (they init at module load from the
    // boot-resolved slug; an in-session set() doesn't cycle them).
    // AUTOSTART_KEY makes the post-reload boot land directly in 'playing'.
    reloadIntoLevel(next.slug, s.solvedPlanets)
  }),
  selectLevel: slug => set(s => {
    if (!getPlanet(slug)) return {}
    // Same reload path as advancePlanet — the in-memory selectLevel that
    // existed previously left HDRI / grass / postfx pinned to the prior
    // level's seed, which read in /game/ as "the HDRI bleeds across
    // levels". Reload is the simplest correct fix; everything else
    // (zustand stores, useControls panels, three uniforms) re-inits.
    reloadIntoLevel(slug, s.solvedPlanets)
  }),
  resetProgress: () => {
    try {
      localStorage.removeItem(TUTORIAL_SEEN_KEY)
      localStorage.removeItem(AUDIO_MUTED_KEY)
    } catch { /* ignore */ }
    audioBus.setMasterMute(false)
    set({ audioMuted: false })
  },
  returnToTitle: () => {
    // Reload so HDRI / grass / postfx re-seed from lvl_1 — the title
    // backdrop is forced to lvl_1, so without a reload the in-memory
    // settings stay pinned to the last-played level's seed and the
    // visible HDRI doesn't match the visible planet. autoStart is
    // unset at this point (it was consumed at the just-finished
    // session's boot), so settings/index.ts sees no flag → seeds
    // from PLANETS[0]. localStorage:progress keeps currentPlanetSlug
    // intact so a subsequent Begin still resumes the last played level.
    if (typeof window !== 'undefined') {
      try { localStorage.removeItem(AUTOSTART_KEY) } catch { /* ignore */ }
      window.location.reload()
    }
  },
  setIntroPhase: v => set(s => (s.introPhase === v ? {} : { introPhase: v })),
  setSceneGrade: v => set(s => (s.sceneGrade === v ? {} : { sceneGrade: v })),
  setTutorialQueue: q => set({ tutorialQueue: q, tutorialStep: 0 }),
  setTutorialStep: n => set({ tutorialStep: n }),
  setHoveredTile: t => set(s => {
    // Shallow-equal check to skip store churn on redundant writes (pointermove
    // fires ~60Hz; most samples land on the same tile).
    const a = s.hoveredTile
    if (a === t) return {}
    if (a && t && a.face === t.face && a.u === t.u && a.v === t.v) return {}
    return { hoveredTile: t }
  }),
  setCommitThreshold: v => set({ commitThreshold: v }),
  setAiEnabled: v => set({ aiEnabled: v }),
  markAiFired: () => set({ aiHasFired: true }),

  beginDragAt: (axis, slice) =>
    set(s => {
      if (s.anim || s.drag) return {}
      return {
        drag: { axis, slice, angle: 0 },
        lastPlayerActionAt: performance.now(),
      }
    }),
  updateDrag: angle =>
    set(s => {
      if (!s.drag) return {}
      const clamped = Math.max(-Math.PI, Math.min(Math.PI, angle))
      return { drag: { ...s.drag, angle: clamped } }
    }),
  endDrag: () =>
    new Promise<void>(resolve => {
      const s = get()
      if (!s.drag) {
        resolve()
        return
      }
      const a = s.drag.angle
      if (Math.abs(a) < 1e-3) {
        set({ drag: null })
        resolve()
        return
      }
      const threshold = s.commitThreshold
      const commitDir: Direction | 0 =
        a >= threshold ? 1 : a <= -threshold ? -1 : 0
      const to = commitDir === 0 ? 0 : commitDir * (Math.PI / 2)
      animResolver = resolve
      set({
        drag: null,
        anim: {
          id: ++animCounter,
          axis: s.drag.axis,
          slice: s.drag.slice,
          from: a,
          to,
          commitDir,
        },
      })
    }),

  rotateAnimated: m =>
    new Promise<void>(resolve => {
      const s = get()
      if (s.anim || s.drag) {
        resolve()
        return
      }
      animResolver = resolve
      set({
        anim: {
          id: ++animCounter,
          axis: m.axis,
          slice: m.slice,
          from: 0,
          to: m.dir * (Math.PI / 2),
          commitDir: m.dir,
        },
      })
    }),

  rotateInstant: m => set(s => applyRotation(s, m.axis, m.slice, m.dir)),

  reset: () =>
    set({
      tiles: buildSolvedTiles(),
      solved: true,
      anim: null,
      drag: null,
      aiHasFired: false,
      lastPlayerActionAt: performance.now(),
      history: [],
    }),

  solve: () => {
    // Snap to the canonical solved state. Unlike reset(), this fires the
    // planet:settled event so the warmth/bloom ramp in PostFx triggers —
    // same payoff the player gets from an organic solve.
    const s = get()
    const wasSolved = s.solved
    set({
      tiles: buildSolvedTiles(),
      solved: true,
      anim: null,
      drag: null,
      lastPlayerActionAt: performance.now(),
      history: [],
    })
    if (!wasSolved) {
      window.dispatchEvent(new CustomEvent('planet:settled'))
    }
  },

  solveAnimated: async () => {
    // Play the recorded history in reverse, each move inverted — lands the
    // puzzle back at solved with one animated slice per step.
    const s = get()
    if (s.solved || s.anim || s.drag) return
    const history = s.history.slice()
    // Clear history first so each rotateAnimated's applyRotation appends
    // fresh inverse moves (keeps state self-consistent if interrupted).
    set({ history: [] })
    const { rotateAnimated } = get()
    for (let i = history.length - 1; i >= 0; i--) {
      // Stop early if the user interacted mid-solve.
      const cur = get()
      if (cur.drag) break
      const inv = inverseMove(history[i])
      // eslint-disable-next-line no-await-in-loop
      await rotateAnimated(inv)
    }
  },

  scrambleInstant: (n = 20) =>
    set(() => {
      const { tiles, moves } = makeScrambledTiles(n)
      // Not firing planet:settled here — puzzle is now unsolved
      return {
        tiles,
        solved: isSolved(tiles),
        anim: null,
        drag: null,
        aiHasFired: false,
        lastPlayerActionAt: performance.now(),
        history: moves,
      }
    }),

  scrambleAnimated: async (n = 20) => {
    const { reset, rotateAnimated } = get()
    reset()
    let prev: Move | undefined
    for (let i = 0; i < n; i++) {
      const m = randomMove(Math.random, prev)
      // eslint-disable-next-line no-await-in-loop
      await rotateAnimated(m)
      prev = m
    }
  },

  _finishAnim: () =>
    set(s => {
      if (!s.anim) return {}
      const { axis, slice, commitDir } = s.anim
      const resolver = animResolver
      animResolver = null
      if (commitDir !== 0) {
        const next = applyRotation(s, axis, slice, commitDir)
        resolver?.()
        return { ...next, anim: null }
      }
      resolver?.()
      return { anim: null }
    }),
}))

// Apply persisted mute + volumes on first import. The audioBus setters are
// idempotent and safe to call before the AudioContext exists — they stash
// the values and applyGraphGains becomes a no-op until init().
audioBus.setMasterMute(readPersistedMute())
audioBus.setMasterVolume(_bootPrefs.masterVolume)
audioBus.setCategoryVolume('sfx', _bootPrefs.sfxVolume)
