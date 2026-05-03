import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * Watch every per-level glb for changes and emit a custom HMR event. Vite
 * normally hot-reloads JS modules, but files in `public/` are served as
 * static assets — they don't go through the module graph, so a glb
 * overwrite (from the Blender addon's Live Mode) doesn't trigger anything
 * client-side. This plugin wires the gap: on file change, push a
 * `diorama:changed` event with `{ slug, ts }` over the HMR socket. TileGrid
 * listens, ignores events for other planets, and re-fetches its own slot
 * with a cache-busting query — no page reload, Leva knob state preserved.
 */

const LEVELS_MANIFEST_PATH = 'public/levels/index.json'

interface LevelEntry {
  slug: string
  name: string
  order: number
  dioramaUrl: string
  audioOverlapMs: number
}

/** Read public/levels/index.json from disk and return its entries. Re-read
 *  on every call (the manifest is small and the dev plugin needs it fresh
 *  if the user adds a level mid-session). */
function loadLevels(): LevelEntry[] {
  const p = path.resolve(__dirname, LEVELS_MANIFEST_PATH)
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as { levels?: LevelEntry[] }
    return Array.isArray(parsed.levels) ? parsed.levels : []
  } catch {
    return []
  }
}

/** Resolve a level slug to its on-disk glb path under public/. Returns null
 *  if the slug isn't in the manifest — caller should reject rather than
 *  guess at a path (commit endpoint must NOT write to a non-whitelisted
 *  path; that would let a malformed query touch arbitrary files). */
function levelGlbPath(slug: string): string | null {
  const levels = loadLevels()
  const e = levels.find(l => l.slug === slug)
  if (!e) return null
  // Strip leading '/' so it joins under public/ rather than rooting absolute.
  const rel = e.dioramaUrl.replace(/^\/+/, '')
  return path.resolve(__dirname, 'public', rel)
}

function dioramaHotReload(): Plugin {
  return {
    name: 'diorama-hot-reload',
    configureServer(server) {
      const levels = loadLevels()
      // Map absolute path → slug so the change handler can identify which
      // level was rewritten in O(1) without a manifest re-read per event.
      const pathToSlug = new Map<string, string>()
      for (const lvl of levels) {
        const abs = path.resolve(__dirname, 'public', lvl.dioramaUrl.replace(/^\/+/, ''))
        pathToSlug.set(abs, lvl.slug)
        server.watcher.add(abs)
      }
      server.watcher.on('change', (file) => {
        const abs = path.resolve(file)
        const slug = pathToSlug.get(abs)
        if (!slug) return
        server.ws.send({
          type: 'custom',
          event: 'diorama:changed',
          data: { slug, ts: Date.now() },
        })
      })
    },
  }
}

/**
 * Dev-only endpoint for the "Commit Settings" Leva button. Writes the
 * captured live state to a per-level file at
 * `public/levels/<slug>/settings.json` so each planet keeps its own
 * HDRI / grass / postfx tuning. Without `?level=<slug>` the request is
 * rejected — the legacy "write to global defaults.json" path was the
 * source of the bug where editing one level's HDRI propagated to every
 * other level (#48).
 *
 * Slug is whitelisted against the manifest before any file write —
 * `levelGlbPath()` returns null for unknown slugs, which keeps the
 * endpoint from creating arbitrary directories on disk.
 */
function settingsCommit(): Plugin {
  return {
    name: 'settings-commit',
    configureServer(server) {
      server.middlewares.use('/__settings/commit', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        try {
          const url = new URL(req.url ?? '', 'http://x')
          const slug = url.searchParams.get('level')
          if (!slug || !levelGlbPath(slug)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: `unknown or missing level slug: ${slug ?? '(none)'}` }))
            return
          }
          const targetPath = path.resolve(__dirname, 'public', 'levels', slug, 'settings.json')
          // Buffer the request body.
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const body = Buffer.concat(chunks).toString('utf8')
          // Parse + re-serialize to guarantee valid JSON on disk and
          // canonical 2-space indentation.
          const parsed: unknown = JSON.parse(body)
          const pretty = JSON.stringify(parsed, null, 2) + '\n'
          await fs.promises.writeFile(targetPath, pretty, 'utf8')
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          const rel = `public/levels/${slug}/settings.json`
          res.end(JSON.stringify({ ok: true, level: slug, path: rel }))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

/**
 * Dev-only endpoint for the mask Commit buttons. POST a PNG body to
 * /__mask/commit/grass or /__mask/commit/flower; we write it to
 * public/grass-mask.png or public/flower-mask.png. Same shape as
 * settingsCommit — parallel endpoint for binary PNG data so the Leva
 * panel can persist a painted/uploaded mask without a manual file drop.
 */
function maskCommit(): Plugin {
  const targets: Record<string, string> = {
    '/__mask/commit/grass':  path.resolve(__dirname, 'public/grass-mask.png'),
    '/__mask/commit/flower': path.resolve(__dirname, 'public/flower-mask.png'),
    '/__mask/commit/walk':   path.resolve(__dirname, 'public/walk-mask.png'),
  }
  return {
    name: 'mask-commit',
    configureServer(server) {
      for (const route of Object.keys(targets)) {
        server.middlewares.use(route, async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: 'POST only' }))
            return
          }
          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            const body = Buffer.concat(chunks)
            // Minimal PNG sanity check: 8-byte signature.
            const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
            if (body.length < 8 || !body.subarray(0, 8).equals(sig)) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'body is not a PNG' }))
              return
            }
            await fs.promises.writeFile(targets[route], body)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, path: path.relative(__dirname, targets[route]) }))
          } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
        })
      }
    },
  }
}

/**
 * Dev-only endpoint for persisting an uploaded HDRI across reloads. Browser
 * blob URLs (URL.createObjectURL) die on navigation, so without disk
 * persistence the HDRIPanel always reverts to the dropdown preset on reload.
 * POST /__hdri/commit?filename=foo.hdr with the raw HDR/EXR/PNG bytes;
 * we hash the body, write to public/hdri/custom-<sha8>.<ext> (extension
 * derived from filename), and return the public path. Same body uploaded
 * twice = same path (content-hashed dedup).
 *
 * Files in public/hdri/ are served by Vite's static-asset path under /hdri/*
 * — no Vite import-graph involvement, no HMR. The hdriStore reads
 * settings.hdri.customPath at module load and points its `url` field at it,
 * so the HDRI auto-restores on next page load.
 */
function hdriCommit(): Plugin {
  const dir = path.resolve(__dirname, 'public/hdri')
  return {
    name: 'hdri-commit',
    configureServer(server) {
      server.middlewares.use('/__hdri/commit', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        try {
          // Buffer the body and derive the extension from the ?filename= query.
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const body = Buffer.concat(chunks)
          const url = new URL(req.url ?? '', 'http://localhost')
          const filename = url.searchParams.get('filename') ?? ''
          const ext = filename.toLowerCase().match(/\.(hdr|exr|png)$/)?.[1]
          if (!ext) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: 'filename must end in .hdr / .exr / .png' }))
            return
          }
          const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8)
          const outName = `custom-${hash}.${ext}`
          const outPath = path.join(dir, outName)
          await fs.promises.mkdir(dir, { recursive: true })
          await fs.promises.writeFile(outPath, body)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            ok: true,
            path: `/hdri/${outName}`,
            filename,
          }))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

/**
 * Rewrite a GLB so the terrain mesh's COLOR_0/1/2 accessors carry the given
 * names ("grass", "flowers", "colliders"). Three.js's GLTFExporter doesn't
 * write BufferAttribute.name to accessor.name; Blender's glTF importer
 * uses accessor.name for Color Attribute layer names. So we surgically
 * edit the JSON chunk, leave the BIN chunk untouched, repack with a
 * recomputed header/JSON-chunk length.
 *
 * GLB layout: 12-byte header (magic 'glTF', version 2, total length) then
 * one or more chunks. Each chunk: 4-byte length, 4-byte type tag (LE),
 * payload. JSON chunk type = 0x4E4F534A ('JSON'). BIN chunk type =
 * 0x004E4942 ('BIN\0', LE). JSON chunk must be 4-byte-aligned (pad with
 * 0x20 spaces); BIN chunk with 0x00.
 */
function patchGlbColorAccessorNames(body: Buffer, names: readonly string[]): Buffer {
  const magic = body.readUInt32LE(0)
  if (magic !== 0x46546C67 /* 'glTF' */) return body
  const jsonChunkLen = body.readUInt32LE(12)
  const jsonChunkType = body.readUInt32LE(16)
  if (jsonChunkType !== 0x4E4F534A /* 'JSON' */) return body
  const jsonStart = 20
  const jsonEnd = jsonStart + jsonChunkLen
  const jsonStr = body.subarray(jsonStart, jsonEnd).toString('utf8')
  let j: { meshes?: Array<{ primitives?: Array<{ attributes: Record<string, number> }> }>; nodes?: Array<{ name?: string; mesh?: number }>; accessors?: Array<{ name?: string }> }
  try {
    j = JSON.parse(jsonStr)
  } catch {
    return body
  }
  // Find the terrain mesh by walking nodes — meshes don't carry names
  // reliably from three.js's exporter, but nodes do. Match by prefix:
  // the exporter writes the node name as `terrain_gameasset` (or similar
  // suffix), not bare `terrain`, so strict equality silently no-oped.
  let terrainMeshIdx = -1
  for (const n of j.nodes ?? []) {
    if (n.name?.startsWith('terrain') && typeof n.mesh === 'number') {
      terrainMeshIdx = n.mesh
      break
    }
  }
  if (terrainMeshIdx < 0 || !j.meshes || !j.accessors) return body
  const prim = j.meshes[terrainMeshIdx].primitives?.[0]
  if (!prim) return body
  const semantics = ['COLOR_0', 'COLOR_1', 'COLOR_2'] as const
  for (let i = 0; i < semantics.length && i < names.length; i++) {
    const accIdx = prim.attributes[semantics[i]]
    if (typeof accIdx === 'number' && j.accessors[accIdx]) {
      j.accessors[accIdx].name = names[i]
    }
  }
  // Re-serialise JSON, pad to 4-byte boundary with spaces.
  let newJson = JSON.stringify(j)
  while (newJson.length % 4 !== 0) newJson += ' '
  const newJsonBuf = Buffer.from(newJson, 'utf8')
  // Reassemble: header(12) + jsonHeader(8) + jsonPayload + binHeader(8) + binPayload.
  const binHeaderStart = jsonEnd
  const tail = body.subarray(binHeaderStart) // BIN chunk header + payload (untouched)
  const newTotalLen = 12 + 8 + newJsonBuf.length + tail.length
  const out = Buffer.alloc(newTotalLen)
  // Header
  out.writeUInt32LE(0x46546C67, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(newTotalLen, 8)
  // JSON chunk header
  out.writeUInt32LE(newJsonBuf.length, 12)
  out.writeUInt32LE(0x4E4F534A, 16)
  newJsonBuf.copy(out, 20)
  // BIN chunk (and any trailing chunks) — unchanged bytes
  tail.copy(out, 20 + newJsonBuf.length)
  return out
}

/**
 * Dev-only endpoint that receives a baked glb (post-process of the canonical
 * Blender-authored asset, NOT a regenerate-from-React) and writes it to
 * public/diorama.glb. Body is patched with grass/flowers/colliders accessor
 * names on its way to disk so the .blend round-trip stays self-documenting.
 *
 * Supports chunked upload via ?session=ID&offset=N (and ?commit=1 to flush).
 * A single-shot full-body POST also works (legacy path). Chunking exists
 * because Playwright's CDP transport blows up V8's 512 MB max-string-length
 * when the in-page POST body crosses ~100 MB; chunks of ~8 MB each keep
 * every CDP message comfortably small.
 */
function dioramaCommit(): Plugin {
  // Per-session in-memory accumulator. Sessions are short-lived (one bake),
  // dev-only, and not user-facing; no eviction policy needed beyond delete-on-commit.
  // Key includes the level slug so two sessions targeting different levels
  // can interleave without colliding on the chunk buffer.
  const sessions = new Map<string, { slug: string; chunks: Buffer[] }>()
  return {
    name: 'diorama-commit',
    configureServer(server) {
      server.middlewares.use('/__diorama/commit-glb', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        try {
          const url = new URL(req.url ?? '', 'http://x')
          const session = url.searchParams.get('session')
          const isCommit = url.searchParams.get('commit') === '1'
          // Default to lvl_1 so legacy callers that don't know about the
          // multi-level layout keep working — the slot they always wrote to.
          const levelSlug = url.searchParams.get('level') ?? 'lvl_1'
          const targetPath = levelGlbPath(levelSlug)
          if (!targetPath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: `unknown level slug: ${levelSlug}` }))
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)

          // Chunked path: append to session, finalise on commit=1.
          if (session) {
            const entry = sessions.get(session) ?? { slug: levelSlug, chunks: [] }
            // Pin the slug to the first chunk's value to prevent a malformed
            // mid-session retarget; reject if a later chunk asks for a
            // different level than the first one established.
            if (entry.slug !== levelSlug) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: `session ${session} pinned to ${entry.slug}, got ${levelSlug}` }))
              return
            }
            for (const c of chunks) entry.chunks.push(c)
            sessions.set(session, entry)
            if (!isCommit) {
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, accumulated: entry.chunks.reduce((n, b) => n + b.length, 0) }))
              return
            }
            const body = Buffer.concat(entry.chunks)
            sessions.delete(session)
            await writeBakedGlb(body, targetPath, res, levelSlug)
            return
          }

          // Single-shot path: write the full body.
          const body = Buffer.concat(chunks)
          await writeBakedGlb(body, targetPath, res, levelSlug)
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

async function writeBakedGlb(
  body: Buffer,
  targetPath: string,
  res: import('http').ServerResponse,
  levelSlug: string,
): Promise<void> {
  if (body.length < 12 || body.readUInt32LE(0) !== 0x46546C67) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: false, error: 'body is not a GLB' }))
    return
  }
  // Three.js's GLTFExporter doesn't propagate BufferAttribute.name to glTF
  // accessor names, but Blender's glTF importer DOES use accessor names for
  // Color Attribute layer names. Patch the terrain mesh's COLOR_0/1/2
  // accessors to "grass"/"flowers"/"colliders" so the .blend round-trip
  // arrives self-documenting instead of with default Color/Color.001/Color.002.
  const patched = patchGlbColorAccessorNames(body, ['grass', 'flowers', 'colliders'])
  await fs.promises.writeFile(targetPath, patched)
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  // Report the public-relative path so the client can log/display it.
  const rel = path.relative(path.resolve(__dirname), targetPath).replace(/\\/g, '/')
  res.end(JSON.stringify({ ok: true, level: levelSlug, path: rel, size: patched.length }))
}

/**
 * Last-active-level beacon. The browser POSTs `{ slug }` here every couple
 * seconds; GET returns the most recent value (with `ageMs` so the consumer
 * can decide if it's stale). The Blender addon's "Auto" live-link mode
 * polls this endpoint to learn which level slot the user is currently
 * editing, so a Live-Mode export writes to the right slug without manual
 * dropdown bookkeeping.
 *
 * In-memory only — no persistence. Multiple tabs are last-write-wins:
 * whatever tab POSTed most recently is what the addon picks up.
 */
function activeLevelBeacon(): Plugin {
  let latest: { slug: string; ts: number } | null = null
  return {
    name: 'active-level-beacon',
    configureServer(server) {
      server.middlewares.use('/__levels/active', async (req, res) => {
        try {
          if (req.method === 'POST') {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            const body = Buffer.concat(chunks).toString('utf-8')
            const parsed = JSON.parse(body) as { slug?: unknown }
            // Whitelist against the manifest — refuse beacons for slugs that
            // don't exist (a stale tab on an old build shouldn't poison the
            // addon's pick).
            if (typeof parsed.slug === 'string' && levelGlbPath(parsed.slug)) {
              latest = { slug: parsed.slug, ts: Date.now() }
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: 'invalid or unknown slug' }))
            return
          }
          if (req.method === 'GET') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'no-store')
            if (!latest) {
              res.end(JSON.stringify({ ok: true, slug: null, ageMs: null }))
              return
            }
            const ageMs = Date.now() - latest.ts
            res.end(JSON.stringify({ ok: true, slug: latest.slug, ageMs }))
            return
          }
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'GET or POST only' }))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), dioramaHotReload(), settingsCommit(), maskCommit(), hdriCommit(), dioramaCommit(), activeLevelBeacon()],
})
