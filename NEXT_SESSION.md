# New-session handoff prompt — Rubic's World (end of `feat/grass`: meadow + Blender round-trip)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — my solo entry for levelsio's **Vibe Jam 2026**.

**Deadline:** 1 May 2026, 13:37 UTC (~9 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5173 (fixed port now that vite.config has a custom plugin)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`
**Current branch:** `feat/grass` — 25 commits on top of main, not yet merged / PR'd.

## Canonical docs (read in this order)

1. `PHASE_1.md` — 15-day plan, scope, stack, cut order, gates.
2. `THESIS.md` — full game design.
3. `BLENDER_PIPELINE.md` — authoring contract for dioramas (face-block layout, subdivision rules, animation compatibility).
4. `blender-plugin/README.md` — install the `rubics_world.py` addon, panel walkthrough, validator rules, live-mode docs.
5. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — `project_architecture_meadow.md` is the CURRENT architecture snapshot. Also read `feedback_blender_pipeline.md`, `project_postfx_strategy.md`, `feedback_library_ref_attachment.md`, `feedback_library_patch_package.md`.
6. `.anvi/` catalogues — `hetvabhasa.md` P1–P13, `vyapti.md` PV1–PV9, `krama.md` PK1–PK4, `dharana.md`.

## Where we are

**Main** still has Day 11 content (onboarding tutorial PR #13, PostFx Path 1 + realism-effects infra PR #15). **`feat/grass` branch adds the entire meadow system + Blender round-trip + HMR live mode + Blender addon on top** — not yet merged to main.

### What ships on `feat/grass`

**Meadow (`src/diorama/buildGrass.ts`, `src/world/GrassPanel.tsx`):**
- Grass + 4 flowers (pink/purple/yellow/red) as 5 separate InstancedMeshes sharing wind uniforms
- Authored in flat cube-net space; rides cube-net → split → cube → sphere pipeline like every other prop
- Wind: rigid Rodrigues rotation of each blade around its root (blade length strictly preserved — isometry); spatial-wave phase from `instanceMatrix[3] · worldWindDir` so the whole field moves as one coherent sheet
- Density: 0–50 slider over a budget of ~230K max instances. Default 25 = 50% coverage.
- Flower %: 0–100% slider trades grass for flowers without double-placing. Per-colour weights + per-colour colour pickers.
- Per-bucket Fisher-Yates shuffle (PV7) so density thinning reads uniformly across all 6 face-blocks, not face-by-face
- AABB exclusion walks named props (`pond`/`trees`/`road`/…) at per-mesh granularity with per-name margin overrides

**Painted mask workflow:**
- `saveDensityMap` / `saveMask` / `saveCubenet` — download 3 PNGs (labelled overlay, clean B/W mask, top-down cube-net render)
- `loadMask` — file picker reads painted mask, `rebuildWithMask(ImageData)` replaces AABB exclusion with pixel sampling
- `clearMask` — drop back to AABB
- `grassRefs.activeMask` persists across hot-reload swaps (PV8) so editing in Blender while a mask is loaded doesn't wipe it

**Blender glTF round-trip:**
- `saveDioramaGlb` Leva button exports a clean flat cube-net `.glb` via GLTFExporter (on a skipMeadow throwaway so the 230K meadow matrices don't bloat the file)
- `?glb=<path>` URL query activates the loader. `?glb=1` → `/diorama.glb`. Defaults to imperative build on any load failure (defensive zero-mesh guard catches stub glbs).
- `loadGlbDiorama` → GLTFLoader + AnimationMixer (frame-delta capped at 100 ms for tab-focus stalls) + `dedupeMaterials` (collapse visually-identical materials — 150→33 on current scene, 3.5× fewer shader compiles)
- Sphere-mode `patchMaterialForSphere` folds `instanceMatrix` into worldPos under `#ifdef USE_INSTANCING` (PV6) — required for any InstancedMesh to be visible in sphere mode

**HMR hot reload (`vite.config.ts` + `src/diorama/TileGrid.tsx`):**
- Custom Vite plugin `dioramaHotReload` watches `public/diorama.glb` via chokidar, emits custom `diorama:changed` WebSocket event with timestamp
- TileGrid listens on `import.meta.hot.on`, refetches with `?t=<ts>` cache-bust, in-place scene swap via `swapInScene(...)` — Leva state survives
- `grassRefs.reapplyControls?.()` runs post-swap so density / flower% / colours / wind / active mask all restore (PV8)

**Blender addon (`blender-plugin/rubics_world.py`, single-file):**
- Install: Edit → Preferences → Add-ons → Install → pick the file → tick checkbox → N-sidebar → "Rubic's World" tab
- Preference: Project Path (repo root)
- Ops: Import Diorama / Export Diorama / Validate Scene / Live Mode (toggle) / Add Face-Block Guides / Remove Guides
- Guides are 3D wireframe cages at Z∈[0, MAX_HEIGHT=1.0] matching the uMaxHeight portal-region ceiling
- Validator is permissive: ERROR only for meshes entirely outside the 8×6 domain; WARNING for PV1 subdivision + sub-terrain dip. Skips terrain/ground/sphere-terrain by name.
- Live Mode: depsgraph_update_post + bpy.app.timers @ 1.5s debounce; two-layer gate (relevant-datablock filter + content fingerprint) so selection/viewport-orbit/driver-eval do NOT trigger exports (P13)
- Blender-native Z-up (PV9); glTF `export_yup=True` bridges to three-js

**Headless scripts (`scripts/`):**
- `blender-make-sample.py` / `blender-roundtrip.py` / `blender-test-addon.py` — all verified passing

### Live workflow (after `npm run dev`)

1. In the browser, open **http://localhost:5173/?glb=1**
2. Install the Blender addon (once), set Project Path, open your diorama
3. Toggle **Live Mode** ON in the Blender panel
4. Edit anything in Blender → auto-export in ≤1.5s → Vite fires `diorama:changed` → browser swaps scene in place. No page reload; every Leva knob, the active mask, camera, tutorial state all survive.

## 🔴 FIRST TASKS — pick one

### Option A — Merge `feat/grass` to main
25-commit branch, not yet PR'd. If the user is happy with the meadow + Blender pipeline, ship it. Run `anvi-ship` or manual PR.

### Option B — Per-cell visibility culling (MEADOW_PERF_CULLING in `.anvi/todos.md`)
After material dedup, sphere mode still runs all 153 glb meshes through 24 per-tile passes. Compute a 6-bit face-block mask per mesh at load time; toggle `mesh.visible` per pass based on whether the mesh overlaps the current tile's face. Expected ~6× draw-call reduction. No shader changes.

### Option C — Mesh merging by shared material (MEADOW_MESH_MERGE)
After dedup, many meshes share a material. Merge into one BufferGeometry per shared-material group (non-skinned, non-animated only). 153 → ~33 meshes. ~5× fewer draws on top of culling.

### Option D — Audio pass
Howler is in deps, still not wired. Earlier handoff options still stand: ambient loop, slice rotation clicks, settle chime, walk-mode footsteps.

### Option E — Bundle split (getting pressing)
~850 KB gzipped pre-meadow. Meadow adds negligible; glb asset is public/diorama.glb so doesn't hit the JS bundle. Split drei/three/realism-effects/lottie into lazy chunks.

## Hard invariants (don't change without reading catalogues)

Adds to the Day 11 list (all Day 11 invariants still hold):

- **PV6:** any `onBeforeCompile` that replaces `<project_vertex>` MUST fold `instanceMatrix` under `#ifdef USE_INSTANCING`. Canonical snippet in `TileGrid.tsx:patchMaterialForSphere`.
- **PV7:** InstancedMesh with user-controlled `mesh.count` must Fisher-Yates shuffle instance matrices in lockstep with any per-instance attribute (`iHue`).
- **PV8:** State that must survive scene rebuilds (mask, Leva panel values) lives in module-scope refs on `grassRefs` AND is re-applied via `grassRefs.reapplyControls?.()` post-swap.
- **PV9:** Blender addon authors in Z-up; glTF `export_yup=True` bridges. Addon + three-js face-block tables use their respective axis conventions.

**New hetvabhasa patterns** (P9–P13): InstancedMesh invisible under vertex patch, `read_factory_settings` segfault, mesh.count order dependency, Blender glTF per-mesh material explosion, depsgraph handler false-positives.

**New krama:** PK3 glTF diorama load lifecycle; PK4 hot-reload swap lifecycle.

## Working style

- Concise. 1–2 sentence end-of-turn.
- Options-not-implementations before non-trivial work; wait for call.
- Playwright for verification; screenshots to `/tmp/rubics-test/`.
- Commits: gitmoji + `Problem:` / `Fix:` body, no `Co-Authored-By`.
- Always-deployable main. Ship branches in sequence.
- Catalogues and memory in sync — when a new pattern emerges, log it before moving on.

## Start by

1. `git status` — should be clean on `feat/grass`.
2. Pull latest — no changes expected but confirm.
3. Pick an option above (lean: A — ship the branch; or B — per-cell culling for a measurable perf win before ship).

---

*End of handoff prompt.*
