/**
 * Level manifest — single source of truth for the sequential progression.
 * The function/type names still say "Planet" because every level IS a
 * planet to the player; on disk and in URLs the slot is identified as
 * `lvl_<N>` so it lines up with the editor route at `/edit/levels/lvl_N/`.
 *
 * The TS const here is duplicated by `public/levels/index.json` for any
 * out-of-bundle consumer (vite middleware, bake script, future planet
 * roster UI). Keep them in sync — the JSON is what the file-watcher /
 * commit endpoints scan for valid slug whitelisting.
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
  { slug: 'lvl_1', name: 'Country Land', order: 0, dioramaUrl: '/levels/lvl_1/diorama.glb', audioOverlapMs: 1200 },
  { slug: 'lvl_2', name: 'Terracotta',   order: 1, dioramaUrl: '/levels/lvl_2/diorama.glb', audioOverlapMs: 1200 },
  { slug: 'lvl_3', name: 'Sage',         order: 2, dioramaUrl: '/levels/lvl_3/diorama.glb', audioOverlapMs: 1200 },
  { slug: 'lvl_4', name: 'Dusty Blue',   order: 3, dioramaUrl: '/levels/lvl_4/diorama.glb', audioOverlapMs: 1200 },
  { slug: 'lvl_5', name: 'Lavender',     order: 4, dioramaUrl: '/levels/lvl_5/diorama.glb', audioOverlapMs: 1200 },
] as const

/** Look up a planet by slug. Returns null if not found. */
export function getPlanet(slug: string): PlanetEntry | null {
  return PLANETS.find(p => p.slug === slug) ?? null
}

/**
 * Return the current planet entry. Defaults to PLANETS[0] (lvl_1 / Country
 * Land); pass a slug to target a specific level (used by the dev /edit/
 * route + the zustand `currentPlanetSlug`). Falls back to PLANETS[0] when
 * the slug is unknown rather than throwing — caller's flow can detect via
 * `getPlanet(slug)` if it needs to error on missing.
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
