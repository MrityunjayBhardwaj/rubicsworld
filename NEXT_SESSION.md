# New-session handoff prompt — Rubic's World (end of Day 13: seam-weld + classic rubik view + Blender Init)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — solo Vibe Jam 2026 entry.

**Deadline:** 1 May 2026, 13:37 UTC (~8 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5173 (custom Vite plugin pins the port)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`
**Current branch:** `feat/seam-investigation` — stacked on `feat/seam-weld` → `feat/grass-from-ground` → `feat/grass` → `main`. **None merged.** Merge stack is the top TODO.

## Canonical reads (in order)

1. `PHASE_1.md` — 15-day plan + stack + cut order.
2. `THESIS.md` — full game design.
3. `BLENDER_PIPELINE.md` — authoring contract (face-block layout, subdivision rules, animation compat).
4. `blender-plugin/README.md` — addon install, panel walkthrough.
5. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — **`project_architecture_day13.md` is the CURRENT snapshot** (meadow.md is SUPERSEDED). Also read `feedback_blender_pipeline.md`, `feedback_shader_patches.md`.
6. `.anvi/` catalogues — `hetvabhasa.md` P1-P20, `vyapti.md` PV1-PV13, `krama.md` PK1-PK5, `dharana.md`.

## Where we are

**Four unmerged branches stacked.** `main` still has only Day 11 content (onboarding tutorial + PostFx infra). Everything below rides on top.

### `feat/grass` — meadow + Blender round-trip + Live Mode + addon
Grass/flower InstancedMeshes (5 buckets), glb round-trip with HMR swap, material dedup (150→33), painted-PNG mask workflow, addon with guides + validate + Live Mode + two-layer dirty gate.

### `feat/grass-from-ground` — grass authoring from the ground
- `buildGrass` finds a mesh named `ground`/`terrain` (PV11), samples its XZ AABB. No fallback; missing ground = console.error + bail.
- `sampleGroundAt` raycasts the ground's triangle grid → blades adhere to sculpted surface and grow along the normal (PV12).
- **Vertex-color density** — Blender Vertex Paint (COLOR_0) → glTF → three → R channel barycentric-interp = per-candidate spawn probability. Composes with AABB exclusions.
- Blender addon's fingerprint now hashes color-attribute bytes (P19 fix) so paint strokes actually fire Live Mode.
- **Root-transform neutralisation** (P14/PV10) — buildGrass saves/zeros/restores `root.position/quat/matrix` because TileGrid overwrites them every frame. Before this fix, the Leva "load mask" button produced ~400 candidates in a sliver (computed in cube-space, not root-local).
- Global `sphere-terrain` backfill skipped when `?glb=` is active (otherwise two grounds double-draw).

### `feat/seam-weld` — Phase A + sphere seam fixes + classic rubik view
- `src/diorama/weldSeams.ts`: snap cube-net boundary verts to exact integers, `mergeVertices` per mesh. Skips InstancedMesh + SkinnedMesh. Saves/restores root (PV10).
- Post-weld `computeVertexNormals()` on the ground (P18) — fixes weld-induced normal pinches and flat-shaded Blender exports.
- **sphere-mode gap = 0** (P16) — within-face clip planes reach face edges exactly; cube/split previews keep their gaps.
- **EDGE_OVERDRAW = 1e-3** on face-boundary planes (P17) — sub-pixel overdraw at cube edges closes hairline sky leaks from float-precision cross-transform drift. Both fixes are needed (PV13).

### `feat/seam-investigation` — classic rubik view + Blender Init + isolate export + hairline fix
- **Classic rubik view** — `src/world/CubeSphere.tsx` (unused since Day 6) re-exposed as fourth preview mode. Own camera profile (`[3.2, 2.2, 3.2]`, fov 45). No HDRI / PostFx / tutorial chrome. GAP=0 in `tileGeometry.ts` removes the dark borders between tiles (canvas background was showing through). UVs added (UV_REPEAT=2).
- **Rubik grass texture toggle** — Leva `Rubik (classic)` folder → `grass` checkbox. Reuses `grassTexture()` upload. **Material KEYS on the toggle** (P15) — toggling a `map` prop post-compile on a live material is silently ignored without a remount.
- **Blender Init Scene** — bmesh-constructed 48×36 grid (P20 — `primitive_plane_add`'s 2-triangle default doesn't survive sphere projection), generated 256×192 cube-net alpha mask packed into the .blend, `blend_method='CLIP'`. `rubics-ground` material, base color TERRAIN_GREEN.
- **Isolate export** — scene-scoped `rubics_isolate_export` BoolProperty (default ON). When on, export skips `rubics-guide-*` helpers AND meshes whose world XY AABB is entirely outside any face block. Ground passes naturally. Implemented via `_with_isolate` context manager + `use_visible=True` on glTF export. Both manual Export and Live Mode use the wrap.

## 🔴 FIRST TASKS — pick one

### Option A — Ship the stack
Four branches = one coherent bundle of meadow + grass-from-ground + seam-weld + rubik-view work. Open ONE PR `feat/seam-investigation` → `main`. Deadline pressure favours one review pass.

### Option B — Audio pass
Howler still unwired. Biggest jam-video uplift per unit effort. Ambient wind loop, slice-rotation click, settle chime, walk-mode footsteps. ~1 day.

### Option C — Per-cell visibility culling
`.anvi/todos.md` MEADOW_PERF_CULLING. Compute a 6-bit face-block mask per mesh at load; toggle `mesh.visible` per pass. Expected ~6× draw reduction.

### Option D — Bundle split
~850 KB gzipped. Matters if jam judges hit fresh. Split drei/three/realism-effects/lottie into lazy chunks.

My lean: **A → B**. Clear the branch stack, then audio for the demo.

## Hard invariants (don't change without reading catalogues)

PV1, PV6, PV7, PV8, PV9 still hold. New this milestone:

- **PV10** — any scene-graph helper called post-mount must save/zero/restore the diorama root's transform. `buildGrass` and `weldCubeNetSeams` already do this.
- **PV11** — grass requires a named ground/terrain; no fallback cube-net.
- **PV12** — blades adhere to ground surface (height + normal) via `sampleGroundAt`.
- **PV13** — sphere mode uses `gap=0` within-face AND `EDGE_OVERDRAW` on face-boundary planes; either alone leaves a seam.

New hetvabhasa entries: **P14** (root transform contamination), **P15** (USE_MAP compile-time define), **P16** (sphere-mode clip gap), **P17** (hairline edge gap from float precision), **P18** (mergeVertices normal pinch), **P19** (fingerprint topology-only misses vertex paint), **P20** (primitive_plane_add chords through sphere).

New krama: **PK5** — glb load post-processing pipeline (dedupe → weld → ground normals → buildGrass → sphere patch, in that order; re-ordering is load-bearing).

## Working style

- Concise. 1–2 sentence end-of-turn.
- Options-not-implementations before non-trivial work.
- Playwright for verification; screenshots to `/tmp/rubics-test/`.
- Commits: gitmoji + `Problem:` / `Fix:` body. No `Co-Authored-By`.
- Always-deployable main. Ship in sequence.
- Catalogues + memory stay in sync; new pattern → catalogue entry before moving on.

## Start by

1. `git status` — should be clean on `feat/seam-investigation`.
2. `git log --oneline main..HEAD` — confirm the stack (~30+ commits).
3. Pick an option above. Lean: **A** (open the PR).

---

*End of handoff prompt.*
