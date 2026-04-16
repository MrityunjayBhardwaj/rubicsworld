import { create } from 'zustand'
import { buildSolvedTiles, isSolved, type Tile } from './tile'
import { rotateSlice, randomMove, type Axis, type Direction, type Move } from './rotation'

export interface AnimState {
  id: number
  axis: Axis
  slice: number
  from: number
  to: number
  commitDir: Direction | 0 // 0 = no commit (snap back), otherwise commit this direction
}

export interface DragState {
  axis: Axis
  slice: number
  angle: number
}

interface PlanetStore {
  tiles: Tile[]
  solved: boolean
  ring: { axis: Axis; slice: number }
  anim: AnimState | null
  drag: DragState | null
  showLabels: boolean

  setShowLabels: (v: boolean) => void
  setRingAxis: (axis: Axis) => void
  cycleRingSlice: () => void

  beginDrag: () => void
  updateDrag: (angle: number) => void
  endDrag: () => Promise<void>

  rotateAnimated: (m: Move) => Promise<void>
  rotateInstant: (m: Move) => void
  reset: () => void
  scrambleAnimated: (n?: number) => Promise<void>

  _finishAnim: () => void
}

let animCounter = 0
let animResolver: (() => void) | null = null

function applyRotation(s: Pick<PlanetStore, 'tiles' | 'solved'>, axis: Axis, slice: number, dir: Direction) {
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
  ring: { axis: 'x', slice: 0 },
  anim: null,
  drag: null,
  showLabels: true,

  setShowLabels: v => set({ showLabels: v }),

  setRingAxis: axis =>
    set(s => (s.ring.axis === axis ? {} : { ring: { ...s.ring, axis } })),
  cycleRingSlice: () =>
    set(s => ({ ring: { ...s.ring, slice: s.ring.slice === 0 ? 1 : 0 } })),

  beginDrag: () =>
    set(s => {
      if (s.anim || s.drag) return {}
      return { drag: { axis: s.ring.axis, slice: s.ring.slice, angle: 0 } }
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
        // trivial click with no meaningful drag — just clear and return
        set({ drag: null })
        resolve()
        return
      }
      const commitDir: Direction | 0 =
        a >= Math.PI / 4 ? 1 : a <= -Math.PI / 4 ? -1 : 0
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

  rotateInstant: m =>
    set(s => applyRotation(s, m.axis, m.slice, m.dir)),

  reset: () =>
    set({ tiles: buildSolvedTiles(), solved: true, anim: null, drag: null }),

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
