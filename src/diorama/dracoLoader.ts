/**
 * Shared DRACOLoader singleton (#80 stage 2 — Blender Draco mesh compression).
 *
 * Three.js's GLTFLoader needs a DRACOLoader registered BEFORE loading to
 * decode KHR_draco_mesh_compression. Without it, Draco-compressed glb
 * meshes silently come through as empty geometry — the scene loads with
 * no error but every mesh is invisible.
 *
 * Decoder assets are vendored at /draco/* (copied from
 * node_modules/three/examples/jsm/libs/draco/ — same files three's
 * recommended path). Self-hosted to keep the app working offline and
 * sidestep P46 (relative path / baseURI gotcha): the leading slash
 * resolves to the document origin regardless of which /edit/* route the
 * user lands on first.
 *
 * Singleton: DRACOLoader spins up a Web Worker pool on first decode; we
 * want the SAME pool reused across all three GLTFLoader call sites
 * (loadGlbDiorama, bakeDiorama, FluidTest) rather than three separate
 * worker pools competing for CPU.
 *
 * Disposal: dispose() is intentionally NOT exposed. The pool lives for
 * the page lifetime; the alternative is recreating the worker pool
 * every glb load which is wasteful.
 */
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

let _instance: DRACOLoader | null = null

function getDracoLoader(): DRACOLoader {
  if (_instance) return _instance
  const loader = new DRACOLoader()
  // Trailing slash matters — DRACOLoader appends `draco_decoder.wasm` etc.
  // to this path without inserting a separator.
  loader.setDecoderPath('/draco/')
  loader.setDecoderConfig({ type: 'wasm' })
  _instance = loader
  return loader
}

/** Attach the shared Draco decoder to a GLTFLoader. No-op if already
 *  attached. Call BEFORE loader.loadAsync / loader.parse — three's
 *  GLTFLoader caches the DRACOLoader at parse start. */
export function attachDracoLoader(loader: GLTFLoader): void {
  loader.setDRACOLoader(getDracoLoader())
}
