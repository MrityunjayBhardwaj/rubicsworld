// Store subscriptions that drive registry events + modulators. One
// module-level guard so StrictMode double-mounts of <AudioBus /> don't
// double-subscribe.
//
//   sliceRotationActive  — bus modulator: 1 while drag||anim, else 0.
//                          Drives the axis_rotation rumble loop. The rumble
//                          covers BOTH the drag and the commit-anim window
//                          end-to-end — no separate one-shot stinger needed.

import { usePlanet } from '../store'
import { audioBus } from './bus'

let installed = false

export function installAudioSubscriptions() {
  if (installed) return
  installed = true

  // Track drag + anim presence; bus tick smooths attack/release so the
  // rumble fades naturally rather than snapping at boundary frames.
  usePlanet.subscribe(state => {
    const active = (state.drag != null || state.anim != null) ? 1 : 0
    audioBus.setSliceRotationActive(active as 0 | 1)
  })
}
