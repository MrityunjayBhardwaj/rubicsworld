import { create } from 'zustand'

/**
 * Records the most recent triggered sound — read by the audio editor's
 * list (`/edit/levels/<slug>/audio`, issue #51) to flash + auto-scroll
 * the row that just fired. Lets the user rotate a tile and watch the
 * `axis_rotation` row light up on the left, then drag a slider on the
 * right to hear the change next rotation.
 *
 * What publishes here:
 *   - One-shot events via `audioBus.play(key)` — every play emits.
 *   - Gesture-bound loops via their subscription handler (e.g.
 *     `subscriptions.ts` publishes `axis_rotation` on the rising edge of
 *     slice-rotation activation, ONCE per gesture — #77). Continuous-tick
 *     loops (ambient_world, birds_flock, …) don't publish; "last
 *     triggered" carries no information for them, and the editor reads
 *     their live gain via audioBus instead.
 *
 * `n` is a monotonic counter (NOT just a timestamp) — two triggers
 * within the same animation frame still produce distinct values. The
 * editor subscribes via `useLastTriggered(s => s.n)` so React re-renders
 * even when the same key fires twice in a row.
 */
export interface LastTriggeredState {
  key: string | null
  t: number
  n: number
  publish: (key: string) => void
}

export const useLastTriggered = create<LastTriggeredState>((set, get) => ({
  key: null,
  t: 0,
  n: 0,
  publish: (key) => set({ key, t: performance.now(), n: get().n + 1 }),
}))
