/**
 * Non-destructive bake. Reads `public/diorama.glb` (Blender's hand-authored
 * export — the canonical asset), applies the same load-time transforms that
 * loadGlbDiorama runs at every page boot, and writes back. The verb finally
 * matches behaviour: bake = process, not regenerate-from-source.
 *
 * Transforms (mirrors loadGlbDiorama, minus the runtime-only steps):
 *   - dedupeMaterials       — collapse visually-identical materials
 *   - weldCubeNetSeams      — snap face-block boundary verts + mergeVertices
 *   - computeVertexNormals  — terrain only, smooths cross-seam shading
 *
 * NOT applied at bake time (runtime concerns only):
 *   - collider AABB registration (read into RAM only, no GLB mutation)
 *   - KHR_audio_emitter URI resolution (URLs already absolute in the source)
 *   - AnimationMixer setup (animations round-trip as-is via GLTFExporter)
 *
 * PV21 / hetvabhasa P44+P45: this MUST NOT route through `gltf-transform`'s
 * writeBinary — it consolidates bufferViews, exposes InterleavedBufferAttribute
 * downstream, and `weldCubeNetSeams.mergeVertices` crashes on the next load.
 * Stay on the three.js scene-graph path (GLTFLoader → in-memory transforms →
 * GLTFExporter); the dev server's existing /__diorama/commit-glb middleware
 * does the surgical accessor-name patch on its way to disk.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { dedupeMaterials } from './loadGlbDiorama'
import { weldCubeNetSeams } from './weldSeams'

interface GlbJsonShape {
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  meshes?: Array<{ primitives?: Array<{ attributes: Record<string, number> }> }>
  materials?: Array<{ extensions?: Record<string, unknown> }>
  textures?: unknown[]
  images?: unknown[]
  nodes?: unknown[]
  accessors?: unknown[]
  bufferViews?: unknown[]
  animations?: unknown[]
  asset?: { generator?: string; version?: string }
  extras?: Record<string, unknown>
}

export interface BakeStats {
  bytesIn:        number
  bytesOut:       number
  meshes:         number
  weldSnapped:    number
  weldMerged:     number
  source: {
    extensionsUsed:     string[]
    extensionsRequired: string[]
    materialExtensions: string[]
    counts: Record<string, number>
    generator?:         string
  }
  result: {
    extensionsUsed:     string[]
    extensionsRequired: string[]
    materialExtensions: string[]
    counts: Record<string, number>
  }
  warnings: string[]
}

export interface BakeResult {
  bytes:  ArrayBuffer | null   // null in dryRun mode
  stats:  BakeStats
}

export interface BakeOptions {
  glbUrl?:   string             // default '/diorama.glb'
  dryRun?:   boolean            // skip the POST, return stats only
}

function inspectGlb(bytes: ArrayBuffer): GlbJsonShape | null {
  if (bytes.byteLength < 20) return null
  const dv = new DataView(bytes)
  if (dv.getUint32(0, true) !== 0x46546C67) return null
  const jsonLen = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== 0x4E4F534A) return null
  try {
    const txt = new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLen))
    return JSON.parse(txt) as GlbJsonShape
  } catch {
    return null
  }
}

function summariseGlb(json: GlbJsonShape | null) {
  if (!json) {
    return {
      extensionsUsed:     [] as string[],
      extensionsRequired: [] as string[],
      materialExtensions: [] as string[],
      counts:             {} as Record<string, number>,
    }
  }
  const matExt = new Set<string>()
  for (const m of json.materials ?? []) {
    for (const k of Object.keys(m.extensions ?? {})) matExt.add(k)
  }
  return {
    extensionsUsed:     [...(json.extensionsUsed ?? [])],
    extensionsRequired: [...(json.extensionsRequired ?? [])],
    materialExtensions: [...matExt],
    counts: {
      meshes:      json.meshes?.length      ?? 0,
      materials:   json.materials?.length   ?? 0,
      textures:    json.textures?.length    ?? 0,
      images:      json.images?.length      ?? 0,
      nodes:       json.nodes?.length       ?? 0,
      accessors:   json.accessors?.length   ?? 0,
      bufferViews: json.bufferViews?.length ?? 0,
      animations:  json.animations?.length  ?? 0,
    },
  }
}

export async function bakeDioramaGlb(opts: BakeOptions = {}): Promise<BakeResult> {
  const { glbUrl = '/diorama.glb', dryRun = false } = opts
  const warnings: string[] = []

  // Fetch raw source bytes (not via GLTFLoader yet — we need the original
  // JSON header for the diff stat, before three.js touches it).
  const res = await fetch(glbUrl)
  if (!res.ok) throw new Error(`fetch ${glbUrl} ${res.status}`)
  const sourceBytes = await res.arrayBuffer()
  const sourceJson  = inspectGlb(sourceBytes)
  const source      = summariseGlb(sourceJson)
  if (!sourceJson) warnings.push('source-not-glb')

  // Parse via GLTFLoader. No KHR_audio_emitter plugin: bake is JSON-only —
  // the audio extension JSON survives via three's userData passthrough on
  // nodes, and the audio plugin's runtime URL resolution would produce side
  // effects we don't want at bake time. (Future: if KHR_audio_emitter ever
  // appears in the source extensionsUsed, we'll need a passthrough plugin.)
  if (sourceJson?.extensionsUsed?.includes('KHR_audio_emitter')) {
    warnings.push('source uses KHR_audio_emitter — exporter may drop this extension; verify before merging')
  }

  const loader = new GLTFLoader()
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
    loader.parse(sourceBytes, '', resolve, reject)
  })

  // Wrap in the same root layout loadGlbDiorama uses, so transforms operate
  // on identical scene-graph shape.
  const root = new THREE.Group()
  root.name = 'diorama'
  root.add(gltf.scene)
  root.updateMatrixWorld(true)

  const beforeMeshes = (() => {
    let n = 0
    root.traverse(c => { if ((c as THREE.Mesh).isMesh) n++ })
    return n
  })()

  // Transforms — same call signatures as loadGlbDiorama.
  dedupeMaterials(gltf.scene)
  const weldStats = weldCubeNetSeams(root)

  // Recompute normals on the ground (matches loadGlbDiorama). Optional:
  // a Blender-baked terrain may have correct normals already, but the weld
  // step's mergeVertices keeps first-seen normals at duplicate seam clusters,
  // which can leave a pinch — recomputing flushes that.
  let groundMesh: THREE.Mesh | null = null
  root.traverse(o => {
    if (groundMesh) return
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const nm = (m.name || '').toLowerCase()
    if (nm.startsWith('ground') || nm.startsWith('terrain')) groundMesh = m
  })
  if (groundMesh) (groundMesh as THREE.Mesh).geometry.computeVertexNormals()
  else warnings.push('no ground/terrain mesh found — normals not recomputed')

  // Export. animations preserved verbatim from gltf.animations.
  const exporter = new GLTFExporter()
  const outBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      gltf.scene,
      result => {
        if (result instanceof ArrayBuffer) resolve(result)
        else reject(new Error('GLTFExporter returned non-ArrayBuffer (binary mode requires ArrayBuffer)'))
      },
      err => reject(err),
      { binary: true, animations: gltf.animations },
    )
  })

  const resultSummary = summariseGlb(inspectGlb(outBytes))

  // Lossy-extension watchdog. If a required extension was used in source
  // and isn't in the result, the round-trip is unsafe — surface loudly.
  for (const ext of source.extensionsRequired) {
    if (!resultSummary.extensionsUsed.includes(ext)) {
      warnings.push(`REQUIRED extension dropped on round-trip: ${ext}`)
    }
  }
  for (const ext of source.extensionsUsed) {
    if (!resultSummary.extensionsUsed.includes(ext)) {
      warnings.push(`extension dropped: ${ext}`)
    }
  }

  const stats: BakeStats = {
    bytesIn:     sourceBytes.byteLength,
    bytesOut:    outBytes.byteLength,
    meshes:      beforeMeshes,
    weldSnapped: weldStats.vertsSnapped,
    weldMerged:  weldStats.vertsMergedAway,
    source:      { ...source, generator: sourceJson?.asset?.generator },
    result:      resultSummary,
    warnings,
  }

  return { bytes: dryRun ? null : outBytes, stats }
}

/**
 * POST the baked bytes through the existing /__diorama/commit-glb middleware
 * (which patches accessor names and writes to disk). Returns the server JSON.
 */
export async function commitBakedGlb(bytes: ArrayBuffer): Promise<{ ok: boolean; size?: number; path?: string; error?: string }> {
  const res = await fetch('/__diorama/commit-glb', {
    method: 'POST',
    headers: { 'Content-Type': 'model/gltf-binary' },
    body: bytes,
  })
  return await res.json().catch(() => ({ ok: false, error: 'non-JSON response' }))
}
