import { settings as globalDefaults, type Settings } from './index'

/**
 * Per-level settings layering (issue #48 Phase B+).
 *
 * Schema layering — three levels, deepest wins:
 *   1. global   ← `src/settings/defaults.json` (compiled in)
 *   2. per-lvl  ← `public/levels/<slug>/settings.json` (sparse override)
 *   3. live     ← Leva edits (handled elsewhere via existing useControls)
 *
 * `levelSettingsLive` is the merged view of (1) ⊕ (2). Consumers that
 * want a per-level override (currently: WalkControls.playerHeight) read
 * here. Existing consumers that read `settings.<section>` from
 * `./index` keep working — they get the global layer, which is still
 * the right answer for fields no level has overridden yet.
 *
 * `loadLevelSettings(slug)` is called from App.tsx whenever
 * currentPlanetSlug changes; it resets the live view to globals and then
 * deep-merges the level's sparse JSON in. Network failure leaves the
 * live view at globals — best-effort, matches the heartbeat / settings-
 * commit conventions used elsewhere.
 */

// Mutable live view. Deep clone of globals so mutations from a level
// override don't leak back into the static `settings` import (which other
// consumers still trust as immutable defaults).
export const levelSettingsLive: Settings = deepClone(globalDefaults)

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** Recursive merge of `src` (sparse override) into `base`. Plain objects
 *  recurse; arrays + primitives + null overwrite. Returns `base` for
 *  chainability — mutates in place. */
function deepMerge(base: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(src)) {
    const sv = src[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      const bv = base[key]
      const target = (bv && typeof bv === 'object' && !Array.isArray(bv))
        ? bv as Record<string, unknown>
        : {}
      deepMerge(target, sv as Record<string, unknown>)
      base[key] = target
    } else {
      base[key] = sv
    }
  }
  return base
}

/** Reset the live view to globals + layer the level's sparse override on
 *  top. Idempotent. Network failure leaves the view at globals. */
export async function loadLevelSettings(slug: string): Promise<void> {
  // Reset before merge so a slug change always reflects ONLY that level's
  // sparse override (no stale fields from a prior level remain).
  Object.assign(levelSettingsLive, deepClone(globalDefaults))
  try {
    const res = await fetch(`/levels/${slug}/settings.json`)
    if (!res.ok) return
    const override = await res.json() as Record<string, unknown>
    deepMerge(levelSettingsLive as unknown as Record<string, unknown>, override)
  } catch {
    /* best-effort — keeps globals on network/parse failure */
  }
}

// ── Typed accessors (extend as more fields layer per-level) ────────────

/** Eye-line altitude above ground in walk mode. Read every frame so a
 *  hot-reloaded settings.json or a level swap takes effect immediately. */
export function getPlayerHeight(): number {
  return levelSettingsLive.walk?.playerHeight ?? 0.16
}
