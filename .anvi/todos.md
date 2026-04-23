# Todos — RubicsWorld

## ONBOARDING_TUTORIAL — replace attract intro with guided 3-move tutorial
**Captured:** 2026-04-19 · **Status:** ✅ shipped in PR #13 (merged)

---

## POSTFX_PATH_1 — pmndrs stack polish pass
**Captured:** 2026-04-20 · **Status:** ✅ shipped in PR #15 (merged)

---

## POSTFX_PATH_2 — realism-effects integration (SSGI + motion blur + TRAA)
**Captured:** 2026-04-20 · **Status:** ✅ **infrastructure shipped** in PR #15 (merged)

SSGI + SSR + motion blur all verified working on three 0.183 via a 5-round patch-package patch (`patches/realism-effects+1.1.2.patch`). Defaults off — exposed in Leva under `PostFx → SSGI / SSR / Motion Blur`. Will become visually relevant when the photoreal Blender diorama lands (PBR materials with bounce-light-worthy geometry).

---

## N8AO_SPHERE_INCOMPAT — N8AO doesn't detect occlusion on our planet
**Captured:** 2026-04-21 · **Status:** diagnosed, workaround shipped, awaiting photoreal diorama

**Finding:** N8AO reconstructs normals from depth neighbour-deltas. Our sphere-projection vertex shader displaces geometry non-linearly → micro-discontinuities at tile seams → `finalAo = 1.0` everywhere (AO-only debug mode renders pure white). DoF and other depth-reading passes work fine on the same buffer.

**Workaround:** SSAO is exposed alongside N8AO in the Leva panel — `PostFx → SSAO → on`. Uses sampled-hemisphere with explicit normal pass; unaffected by depth continuity.

**Expected resolution:** when the photoreal Blender diorama loads (standard MVP-rendered geometry, no custom vertex displacement), N8AO should start working. Verify at that time; if still broken, fork n8ao's shader — but priority: low, SSAO already covers the case.

**Cross-ref:** hetvabhasa P8.

---

## BUNDLE_SPLIT — code-split drei/three/lottie/realism-effects heavy chunks
**Captured:** 2026-04-19 · **Status:** planned, own phase, non-blocking

Bundle is ~850 KB gzipped after Path 1 + realism-effects + lottie. Vite flags >500 KB. Before photoreal Blender diorama lands (adds more mesh + PBR data), split:
- `@react-three/drei` Environment helpers → dynamic import
- `realism-effects` → chunked, lazy loaded only when `sceneGrade === 'photoreal'`
- `lottie-web` → swap for SVG/CSS or load on demand (only needed in tutorial)
- `three` core → separate chunk

Own branch: `feat/bundle-split`.

---

## MEADOW_PERF_CULLING — per-cell visibility culling for glb-loaded diorama
**Captured:** 2026-04-21 · **Status:** proposed, not built

After material dedup (150→33 on current scene), sphere mode still renders each of 153 meshes in all 24 per-tile passes and relies on clip planes to reject fragments. For a 153-mesh glb-loaded diorama this is ~3,700 draw calls/frame + full vertex pipeline on every mesh in every pass.

**Approach:** at load time, compute each mesh's flat-space AABB → 6-bit face-block mask (bit i = overlaps face i). Each per-tile render sets `mesh.visible = (mask & currentFaceBit) !== 0` before `gl.render`. Skips draw call entirely for meshes that can't contribute to this tile. Expected ~6× draw-call reduction on typical single-block-per-mesh scenes.

No shader changes. P5/P8 not applicable. Branch: `perf/per-cell-cull`.

## MEADOW_MESH_MERGE — merge glb meshes sharing a material
**Captured:** 2026-04-21 · **Status:** proposed, follow-up to dedup

After dedupeMaterials runs, many meshes share material refs. Merging those into a single BufferGeometry per shared-material group collapses 153 meshes → ~33 (one per unique material). Per-pass draw calls drop 5×. Tricky for skinned / animated meshes — do per-group merge only when no animation clip targets objects in the group.

## DOF_PERCEPTION — DoF cursor-follow works mechanically but reads as "broken" to the user
**Captured:** 2026-04-23 · **Status:** OPEN — uniforms verified, visual not convincing

**Finding:** After P22 (write to `cocMaterial.focusRange`, not effect prop) and P21 (sphere composite quad writes `gl_FragDepth`), the runtime GPU state is correct: `focusDistance` tracks the raycast hit, `focusRange` eases between on-cursor (1m) and whole-planet (20m), depth buffer is populated. Verified by direct uniform probe (`__dofEffect.cocMaterial.uniforms.focusRange.value`) in a fresh browser session.

**But the user reports the effect still doesn't read as working** even at `bokehScale=4`. A deeper bokeh of 8 produces a dramatic, correct result (center-cursor tile sharp, surroundings heavy bokeh) — so the focus chain IS live. The gap is between "math is right" and "the user sees what they expected from the threejs DoF2 reference."

**Possible root causes (not yet diagnosed):**
- Default bokeh=4 is still visually subtle on our stylized low-poly scene (low-contrast edges don't show bokeh as dramatically as the high-contrast DoF2 example's debug geometry).
- HMR / Leva-stored slider state cached old values across the default bumps; user may be seeing pre-fix numbers without realizing.
- Sphere-projection displaces geometry non-linearly; CoC is per-pixel but the subjective "focus region" the user expects may span across tiles in a way the clipped-plane seams interrupt visually.
- The `dofSmoothing` ease (0.18 default) might be making the focus-point slide too slow to feel responsive — user moves cursor, effect lags.

**Next debug step (don't guess, observe):** ask the user to hard-refresh, enable `PostFx → DoF → debug: show target` (magenta sphere renders at the focus point). If the sphere tracks the cursor on the planet surface, the chain works — the fix is cosmetic (tighten default range, lower smoothing, raise bokeh). If the sphere doesn't move, the cursor→target pipeline has a deeper bug that our probe missed.

**Cross-ref:** hetvabhasa P21, P22. Files: `src/world/PostFx.tsx` DoF useFrame block.

---

## LOTTIE_POLISH — swap placeholder swipe-hint for designed asset
**Captured:** 2026-04-19 · **Status:** quick polish, pre-jam

`src/world/assets/swipe-hint.json` is a hand-authored pulsing dot. Functional but not a "hand swipe" per original intent. Swap for a LottieFiles asset (or a designed custom Lottie). Drop into same path; no code change needed.
