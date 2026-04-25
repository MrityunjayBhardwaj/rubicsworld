// Store subscriptions that drive registry events. One module-level guard so
// StrictMode double-mounts of <AudioBus /> don't double-subscribe.
//
// Two events live here:
//   slice_click   — fires on each ±commitThreshold cross during a drag
//   settle_chime  — fires when an animation completes a commit (commitDir≠0)

import type { AnimState, DragState } from '../store'
import { usePlanet } from '../store'
import { audioBus } from './bus'

let installed = false

export function installAudioSubscriptions() {
  if (installed) return
  installed = true

  // ── slice_click ──────────────────────────────────────────────────────
  // Track which side of the threshold the drag is currently on. Fire only
  // on cross transitions, not on every angle update.
  let prevSign: -1 | 0 | 1 = 0
  usePlanet.subscribe(state => {
    const drag: DragState | null = state.drag
    if (!drag) {
      prevSign = 0
      return
    }
    const T = state.commitThreshold
    const a = drag.angle
    const sign: -1 | 0 | 1 = a >= T ? 1 : a <= -T ? -1 : 0
    if (sign !== prevSign && sign !== 0) audioBus.play('slice_click')
    prevSign = sign
  })

  // ── settle_chime ─────────────────────────────────────────────────────
  // Capture the previous anim so we know commitDir AT THE MOMENT it goes
  // null. _finishAnim sets anim to null after applying the rotation, so
  // observing the anim→null transition is the right event.
  let prevAnim: AnimState | null = null
  usePlanet.subscribe(state => {
    const next = state.anim
    if (prevAnim && !next && prevAnim.commitDir !== 0) {
      audioBus.play('settle_chime')
    }
    prevAnim = next
  })
}
