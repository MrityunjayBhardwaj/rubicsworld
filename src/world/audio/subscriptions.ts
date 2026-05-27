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
import { useLastTriggered } from './lastTriggered'

let installed = false

export function installAudioSubscriptions() {
  if (installed) return
  installed = true

  // Rising-edge memory so we publish ONCE per rotation gesture, not on
  // every drag frame. zustand's listener form gives only `state`, no
  // prev — we compare against this local for the transition.
  let prevSliceActive = 0

  // Track drag + anim presence; bus tick smooths attack/release so the
  // rumble fades naturally rather than snapping at boundary frames.
  usePlanet.subscribe(state => {
    const active = (state.drag != null || state.anim != null) ? 1 : 0
    audioBus.setSliceRotationActive(active as 0 | 1)
    if (active === 1 && prevSliceActive === 0) {
      // Discoverability bridge (#77): the modulator-driven axis_rotation
      // loop has no audioBus.play() call to surface it in the audio editor.
      // Publishing on the rising edge lets the editor's auto-select +
      // flash-row UX point at the rumble loop the moment a rotation
      // starts — same path as one-shot events. Once per gesture, not
      // continuously, so the flash doesn't strobe across drag frames.
      useLastTriggered.getState().publish('axis_rotation')
    }
    prevSliceActive = active
  })
}
