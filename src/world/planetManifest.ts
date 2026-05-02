/**
 * Planet manifest — single source of truth for which planets exist, their
 * order in the sequential progression, and the per-planet asset paths.
 *
 * Phase A scope (issue #48): diorama URL only. Per-planet HDRI / audio bed /
 * walk mask / sparse settings overrides come in Phase B+. The TS const here
 * is duplicated by `public/planets/index.json` for any out-of-bundle consumer
 * (vite middleware, bake script — currently neither reads it; Phase B may).
 *
 * "Sequential progression": planets are ordered by `order`. The PROGRESSION
 * is "current planet" + "set of solved slugs"; next-planet logic lives in the
 * zustand store (added in Phase B). For Phase A there is one planet —
 * `getCurrentPlanet()` always returns it.
 */
export interface PlanetEntry {
  /** stable identifier — used as folder name + storage key */
  readonly slug: string
  /** display name for menus + stats overlay */
  readonly name: string
  /** sort key in the progression (0 = first) */
  readonly order: number
  /** absolute URL the GLB loader should fetch */
  readonly dioramaUrl: string
  /** crossfade window when transitioning audio bed into THIS planet (ms) */
  readonly audioOverlapMs: number
}

export const PLANETS: readonly PlanetEntry[] = [
  {
    slug:           'meadow',
    name:           'Meadow',
    order:          0,
    dioramaUrl:     '/planets/meadow/diorama.glb',
    audioOverlapMs: 1200,
  },
] as const

/** Look up a planet by slug. Returns null if not found. */
export function getPlanet(slug: string): PlanetEntry | null {
  return PLANETS.find(p => p.slug === slug) ?? null
}

/**
 * Return the current planet entry. Phase A only has `meadow`, so this just
 * returns it. Phase B reads `currentPlanetSlug` out of the zustand store.
 * Accepts an optional override slug for code paths that already know which
 * planet they're targeting (bake script, dev tools).
 */
export function getCurrentPlanet(slug?: string): PlanetEntry {
  if (slug) {
    const p = getPlanet(slug)
    if (p) return p
  }
  // PLANETS is non-empty by construction (compile-time guarantee).
  return PLANETS[0]!
}

/**
 * Return the planet that follows the given slug in progression order, or
 * null if the given slug is the last one. Used by the post-solve overlay's
 * Continue button (Phase B).
 */
export function getNextPlanet(currentSlug: string): PlanetEntry | null {
  const current = getPlanet(currentSlug)
  if (!current) return PLANETS[0] ?? null
  const sorted = [...PLANETS].sort((a, b) => a.order - b.order)
  const idx = sorted.findIndex(p => p.slug === currentSlug)
  if (idx < 0 || idx === sorted.length - 1) return null
  return sorted[idx + 1]!
}
