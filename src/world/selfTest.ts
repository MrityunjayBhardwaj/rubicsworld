import { buildSolvedTiles, isSolved } from './tile'
import { rotateSlice, inverseMove, randomMove, type Move } from './rotation'

// Scramble N times, apply inverses in reverse, must end solved.
// Repeated TRIALS times to catch edge cases.
export function runRotationSelfTest(trials = 100, movesPerTrial = 30): { pass: number; fail: number; sample?: Move[] } {
  let pass = 0
  let fail = 0
  let sampleFailure: Move[] | undefined

  for (let trial = 0; trial < trials; trial++) {
    let tiles = buildSolvedTiles()
    if (!isSolved(tiles)) {
      fail++
      continue
    }
    const history: Move[] = []
    let prev: Move | undefined
    for (let i = 0; i < movesPerTrial; i++) {
      const m = randomMove(Math.random, prev)
      tiles = rotateSlice(tiles, m.axis, m.slice, m.dir)
      history.push(m)
      prev = m
    }
    for (let i = history.length - 1; i >= 0; i--) {
      const inv = inverseMove(history[i])
      tiles = rotateSlice(tiles, inv.axis, inv.slice, inv.dir)
    }
    if (isSolved(tiles)) {
      pass++
    } else {
      fail++
      if (!sampleFailure) sampleFailure = history
    }
  }
  return { pass, fail, sample: sampleFailure }
}
