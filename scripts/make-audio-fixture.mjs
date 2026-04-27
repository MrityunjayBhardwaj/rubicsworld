#!/usr/bin/env node
/**
 * Build a minimal .glb fixture with KHR_audio_emitter — used to smoke-test
 * the GLTFLoader plugin without needing Blender. Produces:
 *   public/test-audio-fixture.glb
 *
 * Contents:
 *   - One root scene
 *   - One node "audio:test_windy" at world origin, carrying an emitter that
 *     references public/audio/windy_grass.ogg with radius=12, base vol=0.4
 *
 * Use:
 *   node scripts/make-audio-fixture.mjs
 *   open http://localhost:5173/?glb=/test-audio-fixture.glb
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gltf = {
  asset: { version: '2.0', generator: 'rubics-audio-fixture' },
  scene: 0,
  scenes: [{ name: 'Scene', nodes: [0] }],
  nodes: [
    {
      name: 'audio:test_windy',
      translation: [0, 0, 0],
      // Empty marker mesh would be ideal but glb requires bufferView + accessor
      // for a mesh; we cheat — leave it as a transform-only node. The diorama
      // path's mesh-count check is run on the diorama.glb, not the fixture.
      extensions: {
        KHR_audio_emitter: { emitter: 0 },
      },
    },
  ],
  extensionsUsed: ['KHR_audio_emitter'],
  extensions: {
    KHR_audio_emitter: {
      audio: [{ uri: 'audio/windy_grass.ogg', mimeType: 'audio/ogg' }],
      audioSources: [{ audio: 0, gain: 1.0, loop: true, autoPlay: true }],
      audioEmitters: [{
        type: 'positional',
        name: 'test_windy',
        gain: 0.4,
        sources: [0],
        positional: {
          refDistance: 0,
          maxDistance: 12,
          rolloffFactor: 1.0,
          coneInnerAngle: 360,
          coneOuterAngle: 0,
          distanceModel: 'linear',
        },
        extras: {
          rubics: {
            params: {
              vol: { base: 0.4, modulator: 'windStrength' },
            },
          },
        },
      }],
    },
  },
}

// Need at least one mesh otherwise the loader's `meshCount === 0` guard
// rejects the glb. Add a degenerate triangle on the same node.
const positions = new Float32Array([0, 0, 0,  0.001, 0, 0,  0, 0.001, 0])
const buf = Buffer.from(positions.buffer)
gltf.buffers = [{ byteLength: buf.length }]
gltf.bufferViews = [{ buffer: 0, byteLength: buf.length, target: 34962 }]
gltf.accessors = [{
  bufferView: 0, componentType: 5126, count: 3, type: 'VEC3',
  min: [0, 0, 0], max: [0.001, 0.001, 0],
}]
gltf.meshes = [{
  primitives: [{ attributes: { POSITION: 0 }, mode: 4 }],
}]
gltf.nodes[0].mesh = 0

const json = Buffer.from(JSON.stringify(gltf), 'utf-8')
const jsonPad = (4 - (json.length % 4)) % 4
const jsonChunk = Buffer.concat([json, Buffer.from(' '.repeat(jsonPad), 'ascii')])
const binPad = (4 - (buf.length % 4)) % 4
const binChunk = Buffer.concat([buf, Buffer.alloc(binPad)])

const glb = Buffer.concat([
  // Header
  Buffer.from(Uint32Array.from([
    0x46546C67,                                  // 'glTF'
    2,                                           // version
    12 + 8 + jsonChunk.length + 8 + binChunk.length, // total
  ]).buffer),
  // JSON chunk
  Buffer.from(Uint32Array.from([jsonChunk.length, 0x4E4F534A]).buffer),
  jsonChunk,
  // BIN chunk
  Buffer.from(Uint32Array.from([binChunk.length, 0x004E4942]).buffer),
  binChunk,
])

const outPath = resolve(process.cwd(), 'public/test-audio-fixture.glb')
writeFileSync(outPath, glb)
console.log(`wrote ${outPath} (${glb.length} bytes)`)
