import registryJson from './registry.json'
import { bootLevelSlug } from '../../settings/index'
import type { Registry, LoopDef, EventDef } from './bus'

/**
 * Live, mutable mirror of the audio registry.
 *
 * Why this exists (P53 — module-scope mirror):
 *   - The audio editor (`/edit/levels/<slug>/audio`, issue #51) needs to
 *     mutate registry params live and have the bus pick them up on the
 *     next tick. Hooks-only state can't be reached from non-React code
 *     (the bus's runtime loop) — the mirror gives a stable reference.
 *   - Per-level overrides at boot mirror the same pattern as settings/
 *     index.ts: synchronous XHR before consumers run, deep-merged onto
 *     the global default.
 *
 * Layering (deepest wins):
 *   1. Global  ← `src/world/audio/registry.json` (compiled in)
 *   2. Per-lvl ← `public/levels/<slug>/audio.json` (sparse override)
 *   3. Live    ← editor edits (mutate in place, no separate layer)
 *
 * Array merge by key: `loops[]` and `events[]` are arrays of objects
 * with a `key` field. Naive deep-merge would either concat or wipe the
 * global. Keyed merge: for each entry in the override, find by `.key`
 * and replace fields; otherwise append. This means a level's audio.json
 * only needs to list entries it actually changes.
 *
 * Slug resolution: reuses `settings.bootLevelSlug` to keep one source of
 * truth for "which level is this page editing/playing." That slug is
 * resolved synchronously in settings/index.ts before this module's body
 * runs (settings is a dependency of audioLive).
 */

function deepClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T }

function deepMergeObject(base: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const key of Object.keys(src)) {
    const sv = src[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      const bv = base[key]
      const target = (bv && typeof bv === 'object' && !Array.isArray(bv))
        ? bv as Record<string, unknown>
        : {}
      deepMergeObject(target, sv as Record<string, unknown>)
      base[key] = target
    } else {
      base[key] = sv
    }
  }
}

/** Merge `overrideEntries` into `baseEntries` matched by `.key`. Override
 *  fields shallow-merge into the base entry (with deep-merge for nested
 *  objects like `params`). Entries not in base are appended. */
function mergeKeyed<T extends { key: string }>(baseEntries: T[], overrideEntries: T[]): void {
  for (const ov of overrideEntries) {
    const idx = baseEntries.findIndex(e => e.key === ov.key)
    if (idx >= 0) {
      deepMergeObject(
        baseEntries[idx] as unknown as Record<string, unknown>,
        ov as unknown as Record<string, unknown>,
      )
    } else {
      baseEntries.push(deepClone(ov))
    }
  }
}

/** Synchronous XHR — same trade-off as settings/index.ts. The audio bus
 *  registers loops at init() time off `audioLive`; doing this async would
 *  require deferring bus init, which complicates the entire app boot.
 *  Cache-bust query (P55) — the browser's HTTP cache otherwise serves a
 *  stale audio.json after a Commit + reload. */
function bootFetchOverride(slug: string): { loops?: LoopDef[]; events?: EventDef[] } | null {
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', `/levels/${slug}/audio.json?t=${Date.now()}`, /* async */ false)
    xhr.send()
    if (xhr.status !== 200) return null
    return JSON.parse(xhr.responseText) as { loops?: LoopDef[]; events?: EventDef[] }
  } catch {
    return null
  }
}

const _live: Registry = deepClone(registryJson) as unknown as Registry

if (bootLevelSlug) {
  const override = bootFetchOverride(bootLevelSlug)
  if (override) {
    if (Array.isArray(override.loops)) mergeKeyed(_live.loops, override.loops)
    if (Array.isArray(override.events)) mergeKeyed(_live.events, override.events)
  }
}

/** Stable reference. Consumers iterate `.loops` / `.events` at call time;
 *  the editor mutates entries in place (`.params.vol.base = 0.7`, etc.)
 *  and the bus picks up the new values on its next tick. */
export const audioLive: Registry = _live

/** Mark this audio.json as live-loaded for THIS slug, so the editor's
 *  Commit endpoint knows where to write. Mirrors `bootLevelSlug`. */
export const audioBootSlug: string | null = bootLevelSlug
