import { rotateSlice, type Axis, type Direction, type Move } from './rotation'
import { isSolved, type Tile } from './tile'

const ALL_AXES: Axis[] = ['x', 'y', 'z']

/**
 * Canonical key for a tile array. Serializes (face, u, v) plus a
 * 3-decimal-quantized orientation quaternion per tile, ordered by tile id.
 * Used for BFS visited-set pruning — same key means the cube reads as the
 * same physical state.
 */
function tileKey(tiles: readonly Tile[]): string {
  const parts: string[] = new Array(tiles.length)
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]
    const q = t.orientation
    parts[t.id] =
      `${t.face}.${t.u}.${t.v}|` +
      `${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`
  }
  return parts.join('/')
}

/**
 * Breadth-first search for the shortest solution sequence from the given
 * tile state. Returns the move list or null if no solution exists within
 * maxDepth.
 *
 * Move space: 3 axes × 2 slices × 2 dirs = 12 moves per state. At depth 5
 * the upper-bound frontier is 12^5 ≈ 248K, reduced massively by the
 * visited-set. In practice resolves in a few ms for 2×2 states within a
 * handful of moves of solved — exactly the tutorial's regime.
 *
 * Caller uses this on a user's wrong move to re-point the hint at the new
 * shortest path. If null, the user has scrambled past our tutorial depth
 * and the tutorial should gracefully skip.
 */
export function bfsSolve(tiles: readonly Tile[], maxDepth = 5): Move[] | null {
  if (isSolved(tiles)) return []

  const visited = new Set<string>()
  visited.add(tileKey(tiles))

  type Node = { tiles: readonly Tile[]; path: Move[] }
  let frontier: Node[] = [{ tiles, path: [] }]

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: Node[] = []
    for (const node of frontier) {
      for (const axis of ALL_AXES) {
        for (let slice = 0; slice < 2; slice++) {
          for (const dir of [1, -1] as Direction[]) {
            const newTiles = rotateSlice(node.tiles, axis, slice, dir)
            const key = tileKey(newTiles)
            if (visited.has(key)) continue
            visited.add(key)
            const path = [...node.path, { axis, slice, dir }]
            if (isSolved(newTiles)) return path
            next.push({ tiles: newTiles, path })
          }
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return null
}
