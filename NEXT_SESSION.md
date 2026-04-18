# New-session handoff prompt — Rubic's World (end of Day 8 on fix/day6-sphere-polish)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — my solo entry for levelsio's **Vibe Jam 2026**.

**Deadline:** 1 May 2026, 13:37 UTC (~12 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5176 (current; port drifts)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`

## Canonical docs (read in this order)

1. `PHASE_1.md` — the authoritative 15-day plan, scope, stack, cut order, gates.
2. `THESIS.md` — full game design.
3. `BLENDER_PIPELINE.md` — end-to-end pipeline: cube-net authoring rules, glTF export, engine integration sketch. Reference when shipping any .glb-based diorama.
4. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — `project_architecture_day8.md` is the CURRENT architecture (NOT day6_7), and `feedback_shader_patches.md` documents three hard-earned shader-patching rules.

## Where we are

Branch: `fix/day6-sphere-polish` — ~30+ commits ahead of `main`, still unmerged. PR is overdue; a lot of Day 7–8 work piled on.

### Day 6–7 work (from previous handoff, already shipped locally)
- Sphere pipeline (drag + anim + postfx via FBO + quad, commit-pop fix via tile.orientation).
- VS-style `isSolved`; `solveAnimated` via history replay.
- Cross cube-net layout (8×6 bounding box, 24 filled cells).
- HDRI IBL (drei `<Environment>`) + upload panel; TrackballControls.
- Per-face labels (A1..F4), v-axis flip at source, cube-view row-swap balanced with sphere's `tileToHome`.

### Day 8 work (new since last handoff — all shipped locally on this branch)
- **Global sphere terrain**: replaced per-tile flat terrain in sphere mode with a single `SphereGeometry(1, 96, 64)` mesh rendered once per frame to the FBO, with triplanar grass sampling. Zero across-face seams (one mesh, no rasterization gap at curved cube edges).
- **Per-tile texture rotation persistence**: `sliceRotUniforms` now drives (a) an in-shader slice inverse-rotation for fragments in the active slice during animation and (b) a per-tile orientation array `uTileOriInv: Float32Array(24*4)` so texture stays painted on each tile across commits. Indexed by `face*4 + v*2 + u`. Requires `v = (dot(P, fUp) > 0) ? 0 : 1` (INVERTED — `vOff = (0.5 - v)*CELL`).
- **Idempotent shader patchers**: all three `onBeforeCompile` wrappers (`patchMaterialForFresnel`, `patchMaterialForTriplanar`, `patchMaterialForSphere`) guard against re-entry via `material.userData.__*Patched`. CRITICAL — shared materials (starling flock reuses one across 30 meshes) were silently failing to compile before. READ `feedback_shader_patches.md` before touching any shader patch.
- **PBR pass**: `mat()` defaults `metalness: 0, roughness: 0.85`; pond corrected to `metalness: 0, roughness: 0.05`; all missing roughness values filled in.
- **Normal bug fix** in sphere vertex shader: `mat3(viewMatrix) * sphereNormal` (was `normalMatrix * sphereNormal` which treats world-space normal as object-space → garbage).
- **HDRI Uniform preset**: 256×128 equirect CanvasTexture + auto-PMREM (4×2 is too small and produces degenerate PMREM → black). Color picker UI exposed when preset === 'uniform'.
- **Fresnel toggle** + **Env × mat** + **Rough+** sliders — live per-material knobs. Base roughness cached in `userData.__baseRoughness` so boost is additive.
- **Diorama content authored**: hut relocated to `(-1, 0, +0.5)` (upper row of E) to clear road, driveway stone path re-routed; black asphalt **road** spanning `x ∈ [-4, +4]` at `z = -0.5`, with `BRIDGE` at `x ∈ [-0.35, +0.35]` on raised deck; red low-poly **car** animating around the equator with correct ramp pitch; **two starling flocks** (6 birds each) doing all-to-all attractor boids that merge into one cohesive flock — tight formation, shared heading, obstacle avoidance around hut/windmill/well/bridge/trees.
- **Camera**: reverted sphere from TrackballControls → OrbitControls (polar lock feels more natural for grounded planet sim). `key={...}` forces remount on view change; `makeDefault`; preview `maxDistance` bumped to 60.
- **BLENDER_PIPELINE.md** written — end-to-end workflow for authoring diorama in Blender (cube-net constraints, materials, naming conventions, glTF export settings, engine integration sketch with GLTFLoader).

## 🔴 FIRST TASK — road asphalt invisible on sphere

The black asphalt strip is **not visible in sphere mode** even though the yellow dashes (at `y = ROAD_Y + 0.018`), car, bridge, posts, and ramps all render fine. Earlier this session I bumped `ROAD_Y` from `0.015` → `0.045` thinking it was Z-fighting with the global SphereGeometry terrain at radius 1.0, but **the fix didn't work** — asphalt is still invisible. Need deeper investigation.

Hypotheses to check:
1. Z-fighting isn't fixed — need even higher `ROAD_Y` or an explicit `renderOrder` / `polygonOffset`.
2. Face-boundary clip planes (the 4 planes `n±r`, `n±u`) may be cutting the raised road box where its corners extend into the adjacent face's pyramid. Thin box × raised Y makes this more likely.
3. Sphere shader vertex projection is collapsing the top/bottom of the thin box to the same sphere radius — the box would be invisible because it's a zero-thickness slab after projection. Check `curvedH` behaviour for very small `rawHeight`.
4. Material's `side` or `depthTest`/`depthWrite` flags got nuked by one of the patches.

Good starting point: set `ROAD_Y = 0.15` (much higher — same as bridge's approach height) and see if it becomes visible. If yes, narrows to z-fighting or bezier-curve collapse. If no, the clip planes or material are the culprit.

Diorama road spec is in `src/diorama/buildDiorama.ts` under the "road + car" section.

## Other open items (after road is fixed)

1. **Branch still unmerged** — ~30+ commits on `fix/day6-sphere-polish`. Ship the PR after the road fix.
2. **Day 7 walk mode** (biggest remaining feature per `PHASE_1.md`).
3. **Audio pass** — Howler in deps, nothing wired.
4. **Intro/first-60s framing** — game doesn't teach what to do.
5. **Cap/fill at clip boundaries** — still unresolved (Option 3 single-pass terrain handled it for terrain but objects still show thin seams where they straddle face edges).
6. **Visual cues for "this is a puzzle you can grab"** — discussed but not built. Best pick: per-tile biomes (~make scramble visibly wrong) + cursor-proximate face glow + tilt-on-load.

## Hard invariants (don't change without asking)

- **`includeTerrain: mode !== 'sphere'`** — sphere mode relies on the global `SphereGeometry` terrain; putting per-tile terrain back reintroduces across-face seams.
- **Idempotent `onBeforeCompile` patchers** — shared materials break silently without the `__*Patched` guard.
- **`uTileOriInv` is a `Float32Array(96)`, not `Vector4[]`** — three.js's Vector4-array upload path doesn't reliably propagate updates.
- **Slice uniforms + orientation array written BEFORE `gl.render(terrainScene, camera)`** in `TileGrid.useFrame` — otherwise terrain is one frame stale, snapping back on commit.
- **`v = (dot(P, fUp) > 0) ? 0 : 1`** in `computeTileIdx` (inverted v) — matches `vOff = (0.5 - v) * CELL`.
- **Sphere shader normal fix**: `mat3(viewMatrix) * sphereNormal` (NOT `normalMatrix`).
- **Cross cube-net layout** — 2×3 rectangular layouts can't fold cleanly.
- **Road/bridge/car live in per-tile diorama (`buildDiorama` root)**, so they rotate with their tiles. Flock lives there too.
- Earlier Day 4 invariants still apply: drag-direction picks axis, ring only during drag/anim, 6.5° commit threshold, 2×2 topology.

## Working style

- Concise. 1–2 sentences end-of-turn.
- Brainstorm → option matrix → pick before implementing non-trivial work.
- Playwright for anything non-trivial to verify; screenshots to `/tmp/rubics-test/`.
- Commits: gitmoji + `Problem:` / `Fix:` body, no `Co-Authored-By`.
- Always-deployable main is a hard rule. Ship this branch before bigger work.

## Start by

1. Read `src/diorama/buildDiorama.ts` "road + car" section (~line 660+).
2. Read `src/diorama/TileGrid.tsx` per-tile sphere loop (~line 685+) and sphere vertex shader patch (~line 330+).
3. Debug the invisible asphalt per the 4 hypotheses above — recommend starting with `ROAD_Y = 0.15` as a diagnostic.
4. After it's fixed: ask the user what next — (a) ship the PR, (b) walk mode, (c) other open items.

---

*End of handoff prompt.*
