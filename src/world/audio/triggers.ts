/**
 * Single source of truth for one-shot SFX trigger ids.
 *
 * Why an enum: the audio editor (issue #51) needs to enumerate every
 * possible trigger to populate its bindings UI. Stringly-typed call sites
 * are invisible to TS — adding a new SFX means grep'ing the codebase and
 * hoping you find them all. The enum makes the trigger surface a typed,
 * IDE-discoverable contract.
 *
 * Loops are NOT triggers — they live in `registry.json` under `loops` and
 * fire continuously with modulator-driven gain. This file only enumerates
 * one-shots that game code calls via `audioBus.play(...)`.
 *
 * To add a new trigger:
 *   1. Add the entry below.
 *   2. Add a matching `events[]` row in `registry.json` (or a per-level
 *      `audio.json` override).
 *   3. Call `audioBus.play(Trigger.YourId)` from the game code.
 */
export const Trigger = {
  Footstep: 'footstep',
  Jump: 'jump',
} as const

export type TriggerId = (typeof Trigger)[keyof typeof Trigger]

/** Ordered list for UI consumption (audio editor's trigger-bindings panel). */
export const ALL_TRIGGERS: TriggerId[] = Object.values(Trigger)
