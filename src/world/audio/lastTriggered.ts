import { create } from 'zustand'

/**
 * Records the most recent one-shot event firing — read by the audio
 * editor's event list (`/edit/levels/<slug>/audio`, issue #51) to flash
 * + auto-scroll the row that just fired. Lets the user rotate a tile and
 * watch `tile_rotate` (when wired) light up on the left, then drag a
 * pitchJitter slider on the right to hear the change next rotate.
 *
 * Loops are intentionally NOT tracked here — they fire continuously, so
 * "last triggered" doesn't carry information for them. The editor reads
 * live gain via audioBus.getDebugSnapshot() for loops instead.
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
