import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { usePlanet } from './store'
import { rotateSlice, type Axis, type Direction, type Move } from './rotation'
import type { Tile } from './tile'

const IDLE_THRESHOLD_MS = 8000
const FINAL_THIRD_HOMED_THRESHOLD = 16 // out of 24
const PULSE_TO_SNAP_DELAY_MS = 600

const ALL_MOVES: Move[] = (() => {
  const moves: Move[] = []
  const axes: Axis[] = ['x', 'y', 'z']
  for (const axis of axes) {
    for (const slice of [0, 1]) {
      for (const dir of [1, -1] as Direction[]) {
        moves.push({ axis, slice, dir })
      }
    }
  }
  return moves
})()

function homedCount(tiles: readonly Tile[]): number {
  let n = 0
  for (const t of tiles) {
    if (t.face === t.homeFace && t.u === t.homeU && t.v === t.homeV) n++
  }
  return n
}

function pickHelpfulMove(tiles: readonly Tile[]): Move {
  let best = ALL_MOVES[0]
  let bestScore = -Infinity
  for (const m of ALL_MOVES) {
    const after = rotateSlice(tiles, m.axis, m.slice, m.dir)
    const score = homedCount(after)
    if (score > bestScore) {
      bestScore = score
      best = m
    }
  }
  return best
}

export function AiSeed() {
  const triggering = useRef(false)

  useFrame(() => {
    if (triggering.current) return
    const s = usePlanet.getState()
    if (!s.aiEnabled || s.aiHasFired || s.solved || s.drag || s.anim) return
    if (homedCount(s.tiles) < FINAL_THIRD_HOMED_THRESHOLD) return
    const idle = performance.now() - s.lastPlayerActionAt
    if (idle < IDLE_THRESHOLD_MS) return

    triggering.current = true
    s.markAiFired() // latch so we never retrigger this playthrough
    window.dispatchEvent(new CustomEvent('planet:ai-pulse'))

    setTimeout(() => {
      const cur = usePlanet.getState()
      if (cur.drag || cur.anim) {
        // player resumed during the pulse delay — bow out gracefully
        triggering.current = false
        return
      }
      const move = pickHelpfulMove(cur.tiles)
      void cur.rotateAnimated(move).then(() => {
        window.dispatchEvent(new CustomEvent('planet:ai-tone'))
        triggering.current = false
      })
    }, PULSE_TO_SNAP_DELAY_MS)
  })

  return null
}
