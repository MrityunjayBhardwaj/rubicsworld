import { create } from 'zustand'
import { buildSolvedTiles, isSolved, type Tile } from './tile'
import { rotateSlice, randomMove, type Axis, type Direction, type Move } from './rotation'

export interface ActiveRotation {
  id: number
  axis: Axis
  slice: number
  dir: Direction
}

interface PlanetStore {
  tiles: Tile[]
  active: ActiveRotation | null
  solved: boolean
  rotate: (m: Move) => Promise<void>
  rotateInstant: (m: Move) => void
  commitActive: () => void
  reset: () => void
  scrambleAnimated: (moves?: number) => Promise<void>
}

let activeId = 0
let pendingResolve: (() => void) | null = null

export const usePlanet = create<PlanetStore>((set, get) => ({
  tiles: buildSolvedTiles(),
  active: null,
  solved: true,

  rotate: (m) =>
    new Promise<void>(resolve => {
      if (get().active) {
        resolve()
        return
      }
      pendingResolve = resolve
      set({ active: { id: ++activeId, ...m } })
    }),

  rotateInstant: (m) =>
    set(s => {
      const newTiles = rotateSlice(s.tiles, m.axis, m.slice, m.dir)
      const wasSolved = s.solved
      const nowSolved = isSolved(newTiles)
      if (!wasSolved && nowSolved) {
        window.dispatchEvent(new CustomEvent('planet:settled'))
      }
      return { tiles: newTiles, solved: nowSolved }
    }),

  commitActive: () =>
    set(s => {
      if (!s.active) return {}
      const { axis, slice, dir } = s.active
      const newTiles = rotateSlice(s.tiles, axis, slice, dir)
      const wasSolved = s.solved
      const nowSolved = isSolved(newTiles)
      if (!wasSolved && nowSolved) {
        window.dispatchEvent(new CustomEvent('planet:settled'))
      }
      pendingResolve?.()
      pendingResolve = null
      return { tiles: newTiles, active: null, solved: nowSolved }
    }),

  reset: () => set({ tiles: buildSolvedTiles(), active: null, solved: true }),

  scrambleAnimated: async (moves = 20) => {
    const { rotate, reset } = get()
    reset()
    let prev: Move | undefined
    for (let i = 0; i < moves; i++) {
      const m = randomMove(Math.random, prev)
      // eslint-disable-next-line no-await-in-loop
      await rotate(m)
      prev = m
    }
  },
}))
