// KHR_audio_emitter glTF extension parser plugin.
//
// Spec: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_audio_emitter
//
// Maps glTF emitters to LoopDef registrations on the audio bus:
//   audio[i] = { uri | bufferView }              → loop.src
//   audioEmitter[j] = {
//     type: "positional" | "global",
//     gain, positional: { refDistance, maxDistance, rolloffFactor, ... }
//     extras.rubics = { params, modulator, vol, ... }
//   }
//   node.extensions.KHR_audio_emitter.emitter = j
//
// Anchor wiring:
//   - For nodes that fall inside the diorama subgraph, the bus's existing
//     sphere-projection layer (registerDioramaSource) maps flat→sphere.
//   - For nodes outside the diorama (none today, but future-proof), the
//     emitter just attaches via registerAnchor — directly in main scene.
//
// `extras.rubics` is intentionally project-private. Other glTF viewers see
// the static positional emitter and play it without modulation.

import * as THREE from 'three'
import type { GLTF, GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { audioBus, type LoopDef, type ParamSpec, type VolumeEnvelope } from './bus'

const EXT_NAME = 'KHR_audio_emitter'

interface KhrAudioFile {
  uri?: string
  bufferView?: number
  mimeType?: string
}

interface KhrPositional {
  refDistance?: number
  maxDistance?: number
  rolloffFactor?: number
  coneInnerAngle?: number
  coneOuterAngle?: number
  coneOuterGain?: number
  distanceModel?: 'linear' | 'inverse' | 'exponential'
}

interface KhrEmitter {
  type: 'positional' | 'global'
  name?: string
  gain?: number
  loop?: boolean
  playing?: boolean
  sources?: number[]
  positional?: KhrPositional
  extras?: { rubics?: RubicsExtras }
}

interface KhrSource {
  audio: number
  gain?: number
  loop?: boolean
  autoPlay?: boolean
}

interface KhrTopLevel {
  audio?: KhrAudioFile[]
  audioSources?: KhrSource[]
  audioEmitters?: KhrEmitter[]
}

interface RubicsExtras {
  // Verbatim LoopDef.params shape so the bus needs no translation layer.
  params?: Record<string, ParamSpec>
  // Optional convenience fields the importer also accepts.
  vol?: number
  modulator?: string | string[]
  // Override the auto-generated key (defaults to emitter.name or 'audio_<i>').
  key?: string
  // Baked Speaker.volume keyframe envelope. Authored in Blender; sampled
  // by the bus per tick.
  envelope?: VolumeEnvelope
}

export interface KhrImportResult {
  /** Loop keys registered with the bus during this import. Caller passes
   *  these to `audioBus.unregisterLoop(key)` on diorama swap / unmount. */
  registeredKeys: string[]
}

/**
 * GLTFLoader plugin that parses KHR_audio_emitter and registers each emitter
 * with the audio bus as a runtime LoopDef. Returns an `afterRoot` Promise
 * that resolves once registration is complete; the loaded GLTF's userData
 * gets a `khrAudioEmitter: KhrImportResult` field with the registered keys.
 *
 * Pass an absolute base URL so audio URIs resolve consistently no matter
 * where the .glb itself was fetched from.
 */
export function createKhrAudioEmitterPlugin(baseUrl?: string): (parser: GLTFParser) => GLTFLoaderPlugin {
  return (parser: GLTFParser): GLTFLoaderPlugin => {
    return {
      name: EXT_NAME,

      async afterRoot(result: GLTF) {
        const json = parser.json as { extensions?: Record<string, unknown>; nodes?: { extensions?: Record<string, unknown>; name?: string }[] }
        const ext = json.extensions?.[EXT_NAME] as KhrTopLevel | undefined
        if (!ext || !ext.audioEmitters || !ext.audio) return

        const audio = ext.audio
        const emitters = ext.audioEmitters
        const sources = ext.audioSources ?? []

        // Walk node graph to find which node references which emitter.
        const emitterToNode = new Map<number, THREE.Object3D>()
        const nodeJsonArr = json.nodes ?? []
        // GLTFParser exposes loadNode(index) to materialize, but loaded scene
        // already has all nodes — we can match by index if we mirror parser's
        // traversal. Parser indexes nodes in JSON order; match via name with
        // a fallback to traversal-order index map.
        const nodesByJsonIndex: THREE.Object3D[] = []
        // Re-walk JSON nodes via parser.getDependency — guarantees correct
        // index mapping even with skinned/instanced cases.
        for (let i = 0; i < nodeJsonArr.length; i++) {
          const nodeExt = nodeJsonArr[i].extensions?.[EXT_NAME] as { emitter?: number } | undefined
          if (nodeExt?.emitter == null) continue
          // Resolve the Object3D for this node index. Parser caches the
          // dependency, so this is an in-memory lookup.
          const obj = await parser.getDependency('node', i) as THREE.Object3D
          nodesByJsonIndex[i] = obj
          emitterToNode.set(nodeExt.emitter, obj)
        }

        const registered: string[] = []
        for (let i = 0; i < emitters.length; i++) {
          const em = emitters[i]
          const node = emitterToNode.get(i) ?? null
          if (em.type === 'positional' && !node) {
            // Positional emitter with no node attachment is malformed —
            // skip rather than guess.
            continue
          }

          // Resolve the audio file. Spec: emitter → sources[] → audioSources[k]
          // → audio[m] → uri. Single-source path is the only one we need today.
          const sourceIdx = em.sources?.[0]
          if (sourceIdx == null) continue
          const source = sources[sourceIdx]
          if (!source) continue
          const file = audio[source.audio]
          if (!file) continue

          const src = await resolveAudioSrc(file, parser, baseUrl)
          if (!src) continue

          const rubics = em.extras?.rubics ?? {}
          const key = rubics.key ?? em.name ?? `audio_${i}`

          // Register an anchor for the node so the LoopDef's anchor lookup
          // succeeds. Tag with `__khr_audio_${key}` to keep IDs unique even
          // if the node has its own name used elsewhere.
          const anchorId = `__khr_audio_${key}`
          if (node) {
            // If the node lives under a registered diorama root, use the
            // diorama-source code path so sphere projection runs. Otherwise
            // attach the anchor directly.
            if (isUnderDiorama(node)) {
              audioBus.registerDioramaSource(anchorId, node)
            } else {
              audioBus.registerAnchor(anchorId, node)
            }
          }

          const def: LoopDef = {
            key,
            anchor: node ? `object:${anchorId}` : 'world',
            src,
            // Use radius shorthand when refDistance==0 + maxDistance set + rolloff==1
            // (the bus normalises this to refDist=0/maxDist=radius/rolloff=1).
            // Otherwise pass the explicit triplet through.
            ...(em.positional?.refDistance === 0 && em.positional?.rolloffFactor === 1 && em.positional?.maxDistance != null
              ? { radius: em.positional.maxDistance }
              : {
                  refDist: em.positional?.refDistance,
                  maxDist: em.positional?.maxDistance,
                  rolloff: em.positional?.rolloffFactor,
                }),
            params: rubics.params,
            vol: rubics.vol ?? em.gain,
            modulator: rubics.modulator,
            envelope: rubics.envelope,
          }

          audioBus.registerLoop(def)
          registered.push(key)
        }

        result.userData[EXT_NAME] = { registeredKeys: registered } satisfies KhrImportResult
      },
    }
  }
}

/** True if the node has a parent named 'diorama' (the loadGlbDiorama wrapper). */
function isUnderDiorama(node: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = node.parent
  while (p) {
    if (p.name === 'diorama') return true
    p = p.parent
  }
  // Default: assume yes if we can't decide. Diorama path is the dominant
  // case; sphere projection is a no-op when the source's flat coords
  // happen to round-trip through the projection (origin at (0,0,0)).
  return true
}

async function resolveAudioSrc(file: KhrAudioFile, parser: GLTFParser, baseUrl?: string): Promise<string | null> {
  if (file.uri) {
    // External URI — resolve relative to baseUrl (or document origin) and
    // hand back as-is. THREE.AudioLoader will fetch it.
    if (/^(https?:|data:|blob:)/.test(file.uri)) return file.uri
    if (baseUrl) {
      try { return new URL(file.uri, baseUrl).href } catch { return file.uri }
    }
    return file.uri
  }
  if (file.bufferView != null) {
    // Inline audio: extract bytes, build a blob URL the AudioLoader can fetch.
    const bv = await parser.getDependency('bufferView', file.bufferView) as ArrayBuffer
    const blob = new Blob([bv], { type: file.mimeType ?? 'audio/ogg' })
    return URL.createObjectURL(blob)
  }
  return null
}
