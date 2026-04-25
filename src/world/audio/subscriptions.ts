// Store subscriptions that drive registry events + modulators. One
// module-level guard so StrictMode double-mounts of <AudioBus /> don't
// double-subscribe.
//
//   sliceRotationActive  — bus modulator: 1 while drag||anim, else 0.
//                          Drives the axis_rotation rumble loop.
//   settle_chime         — event: fires when an animation completes a
//                          commit (commitDir≠0).

import type { AnimState } from '../store'
import { usePlanet } from '../store'
import { audioBus } from './bus'

let installed = false

export function installAudioSubscriptions() {
  if (installed) return
  installed = true

  // ── sliceRotationActive ──────────────────────────────────────────────
  // Track drag + anim presence; bus tick smooths attack/release so the
  // rumble fades naturally rather than snapping at boundary frames.
  usePlanet.subscribe(state => {
    const active = (state.drag != null || state.anim != null) ? 1 : 0
    audioBus.setSliceRotationActive(active as 0 | 1)
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
