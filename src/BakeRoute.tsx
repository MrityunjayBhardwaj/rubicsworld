/**
 * Bake page. Reachable at /bake/ in dev. Loads `public/diorama.glb`,
 * applies the same transforms loadGlbDiorama runs at every page boot
 * (dedupe materials, weld cube-net seams, recompute terrain normals),
 * and POSTs the result back through /__diorama/commit-glb to overwrite
 * the on-disk file. NON-DESTRUCTIVE: source is the same file we're
 * processing; running on a Blender-authored asset preserves the asset.
 *
 * Headless via `node bake-diorama.mjs` — Playwright drives this page,
 * polls #bake-status for the JSON result. Dry-run mode (?dryRun=1)
 * skips the POST and reports the diff stats, useful for verifying
 * the round-trip preserves extensions before committing changes.
 */
import { useEffect, useState } from 'react'
import { bakeDioramaGlb, commitBakedGlb, type BakeStats } from './diorama/bakeDiorama'

type Status =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'baking' }
  | { phase: 'committing'; stats: BakeStats }
  | { phase: 'done'; stats: BakeStats; size?: number; path?: string; dryRun: boolean }
  | { phase: 'error'; message: string; stats?: BakeStats }

async function run(setStatus: (s: Status) => void): Promise<void> {
  const dryRun = new URLSearchParams(window.location.search).has('dryRun')
  setStatus({ phase: 'loading' })
  let stats: BakeStats
  let bytes: ArrayBuffer | null
  try {
    setStatus({ phase: 'baking' })
    const result = await bakeDioramaGlb({ dryRun })
    stats = result.stats
    bytes = result.bytes
  } catch (err) {
    setStatus({ phase: 'error', message: `bake failed: ${err instanceof Error ? err.message : String(err)}` })
    return
  }
  if (dryRun) {
    setStatus({ phase: 'done', stats, dryRun: true })
    return
  }
  if (!bytes) {
    setStatus({ phase: 'error', message: 'bake produced no bytes (and not dryRun)', stats })
    return
  }
  setStatus({ phase: 'committing', stats })
  const payload = await commitBakedGlb(bytes)
  if (!payload.ok) {
    setStatus({ phase: 'error', message: `commit failed: ${payload.error ?? 'unknown'}`, stats })
    return
  }
  setStatus({ phase: 'done', stats, size: payload.size, path: payload.path, dryRun: false })
}

export function BakeRoute() {
  const [status, setStatus] = useState<Status>({ phase: 'idle' })
  useEffect(() => {
    run(setStatus).catch(err => setStatus({ phase: 'error', message: String(err) }))
  }, [])
  return (
    <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#ddd', background: '#0a0d12', minHeight: '100vh' }}>
      <h1>Diorama Bake</h1>
      <pre id="bake-status" style={{ background: '#181d24', padding: 16, borderRadius: 8, fontSize: 12, overflowX: 'auto' }}>
        {JSON.stringify(status, null, 2)}
      </pre>
      <p style={{ opacity: 0.6, fontSize: 12 }}>
        Loads <code>public/diorama.glb</code>, runs the same transforms
        loadGlbDiorama applies at every page boot (dedupe materials, weld
        cube-net seams, recompute terrain normals), and writes the result
        back. Non-destructive — source is the same file as target.
        Append <code>?dryRun=1</code> to inspect the round-trip without
        committing.
      </p>
    </div>
  )
}
