# New-session handoff prompt — Rubic's World (end of Day 14: PNG HDRI + DoF depth composite + sphere-mode grass fix, DoF perception still OPEN)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — solo Vibe Jam 2026 entry.

**Deadline:** 1 May 2026, 13:37 UTC (~8 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5173 (custom Vite plugin pins the port)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`
**Current branch:** `feat/seam-investigation` — stacked on `feat/seam-weld` → `feat/grass-from-ground` → `feat/grass` → `main`. **None merged.** The stack is the top TODO.

## Canonical reads (in order)

1. `PHASE_1.md` — 15-day plan + stack + cut order.
2. `THESIS.md` — full game design.
3. `BLENDER_PIPELINE.md` — authoring contract (face-block layout, subdivision rules, animation compat).
4. `blender-plugin/README.md` — addon install, panel walkthrough.
5. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — **`project_architecture_day14.md` is the CURRENT snapshot** (day13.md is SUPERSEDED). Also read `feedback_blender_pipeline.md`, `feedback_shader_patches.md`, `feedback_library_ref_attachment.md`.
6. `.anvi/` catalogues — `hetvabhasa.md` P1–P23, `vyapti.md` PV1–PV13, `krama.md` PK1–PK5, `dharana.md` (B2 and B4 are now FATAL).

## Where we are

**Four unmerged branches stacked.** `main` still has only Day 11 content. Everything below rides on top.

### `feat/grass` — meadow + Blender round-trip + Live Mode + addon
InstancedMesh grass/flowers (5 buckets), glb round-trip with HMR swap, material dedup (150→33), painted-PNG mask workflow, addon with guides + validate + Live Mode + two-layer dirty gate.

### `feat/grass-from-ground` — grass authoring from the ground
Ground-named-mesh sourcing (PV11), triangle-grid raycast to adhere blades to sculpted surface (PV12), Blender vertex-paint drives per-blade density (COLOR_0 → glTF → three → R channel). Fingerprint hashes color-attribute bytes so paint strokes fire Live Mode.

### `feat/seam-weld` — Phase A + sphere seam fixes + classic rubik view
Phase-A cube-net seam weld (snap boundary verts to integers, mergeVertices per mesh). Post-weld `computeVertexNormals()` on the ground (P18). Sphere-mode `gap=0` within-face (P16). `EDGE_OVERDRAW=1e-3` on face-boundary clip planes (P17).

### `feat/seam-investigation` — classic rubik view + Blender Init + Day-14 DoF/grass work
- **Classic rubik view** — `src/world/CubeSphere.tsx` re-exposed as a fourth preview mode.
- **Blender Init Scene** — bmesh-constructed 48×36 grid (P20 fix), 256×192 cube-net alpha mask packed in, `rubics-ground` material. Isolate export skips non-face-block props.
- **Day 14 additions (new since Day 13):**
  - **PNG HDRI uploads** (`5962544`) — HDRIPanel accepts `.png` equirects; PNGs loaded via `TextureLoader` with `EquirectangularReflectionMapping` and passed to `<Environment map={...}>` (drei's extension-based loader doesn't recognize PNG, and blob URLs have no extension).
  - **Sphere-mode depth composite** (`4fd853b`, P21) — `useFBO({ depthBuffer: true })` attaches a `DepthTexture`; composite quad samples it and writes `gl_FragDepth`. Main framebuffer now has real per-pixel planet depth so DoF / N8AO / SSAO / SSGI all see a valid depth buffer.
  - **DoF focus range written to the right object** (`e1c5f98`, P22) — `DepthOfFieldEffect` has NO live `worldFocusRange` setter; it's a constructor-only option. Per-frame writes to `effect.worldFocusRange` created a stray JS property no uniform ever read. Fix: `effect.cocMaterial.focusRange = value`. Verified via runtime probe — off-planet range eases to 20, on-planet eases to 1.
  - **DoF defaults tuned** (`3ad3450`) — rangeWholePlanet 20m, rangeOnCursor 1m, bokehScale 4.
  - **Sphere-mode grass restored** (`c00ef33`, P23) — split presence from visibility. `buildDiorama({ includeTerrain: true })` always; `hideFlatTerrainInSphereMode(root, mode)` sets `terrain.visible=false` in sphere mode. `traverse()` still visits invisible meshes so `buildGrass` can find the geometry; renderer skips the draw. Verified: imperative sphere now spawns 41,275 grass blades + ~83,000 flowers.

## 🔴 FIRST TASKS — pick one

### Option A — Ship the stack
Four branches = one coherent bundle. Open ONE PR `feat/seam-investigation` → `main`. Deadline pressure favours one review pass.

### Option B — DOF_PERCEPTION (still open)
Uniforms are verified-correct on the GPU (probe `__dofEffect.cocMaterial.uniforms.focusRange.value` — eases 20 → 1 between off and on). At `bokehScale=8` the effect is dramatic. But the user reports the current `bokehScale=4` defaults still don't read as "working". See `.anvi/todos.md#DOF_PERCEPTION` for the full diagnosis-so-far. **Next debug step**: enable `PostFx → DoF → debug: show target` (magenta sphere renders at the focus point). If it tracks the cursor on the planet, the fix is cosmetic tuning (tighter default range, lower smoothing, higher bokeh); if it doesn't track, there's a deeper pipeline issue our probe missed. DO NOT just ship more default bumps without observing the debug sphere behaviour first — that's the root-cause signal this issue needs.

### Option C — Audio pass
Howler still unwired. Ambient wind, slice-rotation click, settle chime, walk-mode footsteps. ~1 day.

### Option D — Per-cell visibility culling
`.anvi/todos.md` MEADOW_PERF_CULLING. ~6× draw-call reduction on glb scenes.

### Option E — Bundle split
~850 KB gzipped. Split drei/three/realism-effects/lottie into lazy chunks.

My lean: **B first** (the DoF debug-target observation is a 60-second read and unblocks whether we need code changes or just doc for the jam build), then **A** (ship), then **C** (audio).

## Hard invariants (don't change without reading catalogues)

PV1, PV6, PV7, PV8, PV9, PV10, PV12, PV13 still hold.

- **PV11 (updated Day 14)** — grass requires a ground/terrain-named mesh IN THE DIORAMA ROOT; presence ≠ visibility. Render-path optimizations that REMOVE the mesh from the root violate this (that was the Day 14 regression). Toggle `.visible` instead.

New hetvabhasa entries this day: **P21** (offscreen composite missing depth breaks post-fx), **P22** (constructor-only option is a dead write), **P23** (render-path optimization that omits a mesh breaks lookup-based consumers).

Dharana boundaries now FATAL:
- **B2** (R3F ↔ postprocessing EffectComposer) — 4 patterns clustered (P4, P6, P7, P22).
- **B4** (offscreen composite ↔ depth-dependent post-effects) — 3 patterns clustered (P8, P21, P23). Renamed from its earlier N8AO-specific scope.

## Working style

- Concise. 1–2 sentence end-of-turn.
- **Observation over inference.** Runtime probes BEFORE claiming a fix works. If the user reports "still broken" after a claimed fix, add a probe for the actual GPU uniform / scene-graph state instead of speculating. The Day 14 DoF saga shipped two wrong "fixes" before the probe revealed `cocMaterial.uniforms.focusRange.value` was the ground truth.
- Options-not-implementations before non-trivial work.
- Playwright for verification; screenshots to `/tmp/rubics-test/`. CDP `Page.captureScreenshot` bypasses Playwright's font-load wait when the page has a live WebGL canvas.
- Commits: gitmoji + `Problem:` / `Fix:` body. No `Co-Authored-By`.
- Always-deployable main. Ship in sequence.
- Catalogues + memory stay in sync; new pattern → catalogue entry before moving on.

## Start by

1. `git status` — should be clean on `feat/seam-investigation`.
2. `git log --oneline main..HEAD` — confirm the stack (~35+ commits).
3. Pick an option above. Lean: **B** (check debug sphere before any more DoF code), then **A** (ship).

---

*End of handoff prompt.*
