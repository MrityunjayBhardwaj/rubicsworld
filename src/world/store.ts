import { create } from 'zustand'
import { buildSolvedTiles, isSolved, type Tile } from './tile'
import { rotateSlice, randomMove, inverseMove, type Axis, type Direction, type Move } from './rotation'

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
  commitThreshold: number // radians; drag past this and release → commit
  aiEnabled: boolean
  aiHasFired: boolean // per-playthrough latch; resets on scramble/reset
  lastPlayerActionAt: number // ms timestamp of last committed player rotation
  history: Move[] // moves applied since last reset/solve — replayed in reverse by solveAnimated

  setShowLabels: (v: boolean) => void
  setShowRing: (v: boolean) => void
  setOnPlanet: (v: boolean) => void
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

const INITIAL_SCRAMBLE_MOVES = 20
const initialScramble = makeScrambledTiles(INITIAL_SCRAMBLE_MOVES)

let animCounter = 0
let animResolver: (() => void) | null = null

function applyRotation(
  s: Pick<PlanetStore, 'tiles' | 'solved' | 'history'>,
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
  }
}

export const usePlanet = create<PlanetStore>((set, get) => ({
  tiles: initialScramble.tiles,
  solved: isSolved(initialScramble.tiles),
  anim: null,
  drag: null,
  showLabels: false,
  showRing: false,
  onPlanet: false,
  commitThreshold: (6.5 * Math.PI) / 180, // 6.5° — tuned for a light digital feel
  aiEnabled: true,
  aiHasFired: false,
  lastPlayerActionAt: typeof performance !== 'undefined' ? performance.now() : 0,
  history: initialScramble.moves,

  setShowLabels: v => set({ showLabels: v }),
  setShowRing: v => set({ showRing: v }),
  setOnPlanet: v => set(s => (s.onPlanet === v ? {} : { onPlanet: v })),
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
