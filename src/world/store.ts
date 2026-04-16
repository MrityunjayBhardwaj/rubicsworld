import { create } from 'zustand'
import { buildSolvedTiles, isSolved, type Tile } from './tile'
import { rotateSlice, randomMove, type Axis, type Direction, type Move } from './rotation'

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

  setShowLabels: (v: boolean) => void
  setShowRing: (v: boolean) => void
  setOnPlanet: (v: boolean) => void
  setCommitThreshold: (v: number) => void

  beginDragAt: (axis: Axis, slice: number) => void
  updateDrag: (angle: number) => void
  endDrag: () => Promise<void>

  rotateAnimated: (m: Move) => Promise<void>
  rotateInstant: (m: Move) => void
  reset: () => void
  scrambleInstant: (n?: number) => void
  scrambleAnimated: (n?: number) => Promise<void>

  _finishAnim: () => void
}

let animCounter = 0
let animResolver: (() => void) | null = null

function applyRotation(
  s: Pick<PlanetStore, 'tiles' | 'solved'>,
  axis: Axis,
  slice: number,
  dir: Direction,
) {
  const newTiles = rotateSlice(s.tiles, axis, slice, dir)
  const nowSolved = isSolved(newTiles)
  if (!s.solved && nowSolved) {
    window.dispatchEvent(new CustomEvent('planet:settled'))
  }
  return { tiles: newTiles, solved: nowSolved }
}

export const usePlanet = create<PlanetStore>((set, get) => ({
  tiles: buildSolvedTiles(),
  solved: true,
  anim: null,
  drag: null,
  showLabels: false,
  showRing: false,
  onPlanet: false,
  commitThreshold: Math.PI / 8, // ~22.5°, much lighter than physical 45°

  setShowLabels: v => set({ showLabels: v }),
  setShowRing: v => set({ showRing: v }),
  setOnPlanet: v => set(s => (s.onPlanet === v ? {} : { onPlanet: v })),
  setCommitThreshold: v => set({ commitThreshold: v }),

  beginDragAt: (axis, slice) =>
    set(s => {
      if (s.anim || s.drag) return {}
      return { drag: { axis, slice, angle: 0 } }
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
    set({ tiles: buildSolvedTiles(), solved: true, anim: null, drag: null }),

  scrambleInstant: (n = 20) =>
    set(() => {
      let tiles = buildSolvedTiles()
      let prev: Move | undefined
      for (let i = 0; i < n; i++) {
        const m = randomMove(Math.random, prev)
        tiles = rotateSlice(tiles, m.axis, m.slice, m.dir)
        prev = m
      }
      // Not firing planet:settled here — puzzle is now unsolved
      return { tiles, solved: isSolved(tiles), anim: null, drag: null }
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
