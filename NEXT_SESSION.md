# New-session handoff prompt — Rubic's World (Day 17 end: walk mode + 3-layer terrain + Blender 2-collection model on branch features-and-fixes)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — solo Vibe Jam 2026 entry.

**Deadline:** 1 May 2026, 13:37 UTC (~6 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5173
**Bake offline:** `node bake-diorama.mjs` (rebuilds `public/diorama.glb` from imperative source)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`
**Current branch:** `features-and-fixes` — branched off `main` after PR #16 (DoF + full PostFx) and PR #17 (TS build fixes). ~30+ commits above main, **NOT pushed yet**.

## Canonical reads (in order)

1. `PHASE_1.md` — 15-day plan + stack + cut order.
2. `THESIS.md` — game design.
3. `BLENDER_PIPELINE.md` — authoring contract.
4. `blender-plugin/README.md` — addon walkthrough.
5. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — **`project_architecture_day17.md` is the current snapshot** (day16 SUPERSEDED). Also read `feedback_dof_integration.md`, `feedback_shader_patches.md`, `feedback_library_ref_attachment.md`.
6. `.anvi/` catalogues — hetvabhasa P1–P38 (P31–P38 new this session), vyapti PV1–PV17 (PV14–PV17 new), krama PK1–PK7 (PK6–PK7 new), dharana B2/B4 with B4 expanded to 8 patterns.
7. `src/settings/defaults.json` — single source of truth for grass/flowers/HDRI defaults.

## Where we are (Day 17 ⇒ session ended fresh)

Branch went from "walk mode shipped" to "city-ready collision pipeline + glb-as-canonical bake." Everything below is **uncommitted on `features-and-fixes`** but type-checks clean, runs, and the baked glb on disk reflects the latest source.

### Walk mode — fully functional
- Pointer-lock (infinite mouse-look), Esc releases lock + exits walk
- Leva auto-hidden in walk mode
- 2× player height (PLAYER_H = 0.16); per-frame raycast height-follow on the ground; Space-jump with gravity
- 0.7s smoothstep entry from orbit pose → walk spawn
- Grass-trail brush stamps from the camera position — blades bend behind the player same fade as cursor brush
- **Three-gate collision** in `WalkControls.tryStep`:
  1. PNG walk-mask (falls back to `grass-mask.png` if no `walk-mask.png`)
  2. AABB list from Blender's `rubics_collider` collection
  3. Vertex-color `colliders` layer on the terrain mesh (R < 0.5 = blocked)

### Three-layer terrain vertex colors
- `buildTerrain()` ships `color`/`color_1`/`color_2` BufferAttributes named `grass`/`flowers`/`colliders` (all-white defaults except grass which carries the cross-net dim mask).
- `buildGrass.ts` consumes them positionally; exposes `grassRefs.sampleColliderAt(flatX, flatZ)`.
- Plugin's "Ensure Density Layers" enforces canonical names + ordering, migrating legacy `Color` / `Color.001` / `grass_density` / `flower_density` / `walk` etc.
- Server-side `vite.config.ts:patchGlbColorAccessorNames` writes accessor.name post-export → Blender shows `grass`/`flowers`/`colliders` instead of auto-numbered defaults.

### Blender plugin — two-collection model
- `rubics_diorama` (renderable) and `rubics_collider` (invisible AABB cubes)
- New ops: `Ensure Collections`, `Add Static`, `Add Dynamic` (spawns wireframe cube at 3D cursor)
- Export tags `userData.rubics_role` via context manager + `export_extras=True`
- Import operator sorts incoming nodes by `rubics_role` into the right collection

### BakeRoute (`/bake/` standalone page)
- Non-rendering React tree: builds throwaway diorama, strips texture refs, auto-generates 11 colliders, samples animations 30Hz × 16s (covers car's 14.5s loop), exports + commits.
- `bake-diorama.mjs` is a Playwright driver that hits `/bake/` headlessly. Headless WebGL works because no per-frame load.
- Vite middleware `/__diorama/commit-glb` writes to disk + patches accessor names.

### Sphere-terrain reads PBR from authored terrain
- `buildSphereTerrain(sourceMat?)` accepts an override; TileGrid traverses for the hidden `terrain` mesh and forwards. Closes the P23-family channel where Blender PBR edits never reached the visible sphere.

### Diagnosed but NOT fixed (deferred)
- **`metallicRoughnessTexture` overrides the Metallic slider** (P32). Blender's Principled BSDF effective metalness = `factor × texture.B`; if texture's B channel is ~0, slider has no effect. Fix in Blender = disconnect the texture noodle from Metallic input.
- **applyIblKnobs caches `__baseRoughness` on first sight** (P36). Direct material-property writes get stomped next frame unless you also reset `userData.__baseRoughness`.
- **Bake strips textures** (P34). Round-trip via Blender's Export Diorama preserves them; the JS bake doesn't (yet). Wire `await image.decode()` per texture if texture-fidelity round-trip becomes important.

## Public files

```
public/
  diorama.glb          807 KB; 11 colliders, 2 anim tracks, terrain has named grass/flowers/colliders layers
  grass-mask.png       painted exclusion mask for grass distribution
  flower-mask.png      painted exclusion mask for flowers
  walk-mask.png        OPTIONAL — falls back to grass-mask if absent
```

## 🔴 FIRST TASKS — pick one

### Option A — Ship features-and-fixes to main (~45 min)
Commit in 3-4 logical chunks, push, open PR. ~30+ commits of polish should land before the deadline. **Recommended.** The longer it sits unmerged, the harder rebase gets.

### Option B — Audio pass (~1 day)
Howler still unwired. Ambient wind, slice-rotation click, settle chime, walk-mode footsteps, jump SFX. Big perceptual win for the jam build.

### Option C — Build the City planet (~3-4 days)
Next milestone per memory. Will exercise dynamic AABB + vertex-collider paths heavily — the architecture is ready, the content isn't.

### Option D — Bundle split / perf
~1 MB gzipped now; split drei/three/realism-effects/lottie into lazy chunks. Mobile-first bandwidth savings.

My lean: **A** (ship), then **B** (audio fills the silence on the jam build), then **C** if time permits.

## Hard invariants (don't change without re-reading catalogues)

All PV1–PV17 hold. Notable for this session:
- **PV14:** color attributes are positional. Reorder = both Blender plugin AND three.js side update simultaneously.
- **PV15:** visible mesh is source of truth — hidden-twin authoring must explicit-forward.
- **PV16:** bake routes are CPU-only — no FBO/composite/postfx in `/bake/`.
- **PV17:** authored layer ordering is the round-trip contract.

**Three-gate walk collision must stay 3 gates.** Skipping any silently regresses authoring.

## Working style

- Concise. 1–2 sentence end-of-turn.
- **Observation over inference.** Runtime probes before claiming a fix. For walk/grass/postfx specifically: page-reload after shader changes (onBeforeCompile caches results).
- Options-not-implementations before non-trivial work.
- Playwright for verification; bakes via `node bake-diorama.mjs` (NOT via UI button — UI button works in browser, but the headless flow goes through `/bake/`).
- Commits: gitmoji + `Problem:` / `Fix:` body. No `Co-Authored-By`.
- Always-deployable main. Ship in sequence.
- Catalogues + memory stay in sync; new pattern → catalogue entry before moving on.

## Start by

1. `git status` — should be clean OR have today's diffs ready to stage.
2. `git log --oneline main..HEAD` — confirm the branch commit list.
3. `npm run dev` → http://localhost:5173. Press Tab → walk mode → cursor locks, mouse look is infinite, WASD walks, Space jumps. Walk into a hut → blocked. Esc releases.
4. http://localhost:5173/?glb=1 — same scene from the baked glb.
5. http://localhost:5173/bake/ — re-bake (or run `node bake-diorama.mjs`).
6. Pick an option above. Lean: **A** (ship) → **B** (audio).

---

*End of handoff prompt.*
