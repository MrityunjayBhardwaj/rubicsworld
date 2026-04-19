import { create } from 'zustand'
import { buildSolvedTiles, isSolved, type Tile } from './tile'
import { rotateSlice, randomMove, inverseMove, type Axis, type Direction, type Move } from './rotation'
import type { FaceIndex } from './faces'

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
  onPlanet: boolean
  hoveredTile: HoveredTile | null
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
   *    'done'            — player engaged; camera + input yield to them
   *  Auto-orbit is enabled while this is NOT 'done'. */
  introPhase: 'orbit-solved' | 'scrambling' | 'orbit-scrambled' | 'done'
  commitThreshold: number // radians; drag past this and release → commit
  aiEnabled: boolean
  aiHasFired: boolean // per-playthrough latch; resets on scramble/reset
  lastPlayerActionAt: number // ms timestamp of last committed player rotation
  history: Move[] // moves applied since last reset/solve — replayed in reverse by solveAnimated

  setShowLabels: (v: boolean) => void
  setShowRing: (v: boolean) => void
  setOnPlanet: (v: boolean) => void
  setHoveredTile: (t: HoveredTile | null) => void
  setEasyMode: (v: boolean) => void
  setCameraMode: (v: 'orbit' | 'walk') => void
  setIntroPhase: (v: PlanetStore['introPhase']) => void
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
  if (!s.solved && nowSolved) {
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
  onPlanet: false,
  hoveredTile: null,
  hudAttractMode: true,
  easyMode: false,
  cameraMode: 'orbit',
  introPhase: 'orbit-solved',
  commitThreshold: (6.5 * Math.PI) / 180, // 6.5° — tuned for a light digital feel
  aiEnabled: true,
  aiHasFired: false,
  lastPlayerActionAt: typeof performance !== 'undefined' ? performance.now() : 0,
  history: [],

  setShowLabels: v => set({ showLabels: v }),
  setShowRing: v => set({ showRing: v }),
  setOnPlanet: v => set(s => (s.onPlanet === v ? {} : { onPlanet: v })),
  setEasyMode: v => set({ easyMode: v }),
  setCameraMode: v => set(s => (s.cameraMode === v ? {} : { cameraMode: v })),
  setIntroPhase: v => set(s => (s.introPhase === v ? {} : { introPhase: v })),
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
