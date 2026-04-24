# New-session handoff prompt — Rubic's World (Day 15 end: DoF perception SOLVED on branch debug/dof-only; integration + merge still open)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — solo Vibe Jam 2026 entry.

**Deadline:** 1 May 2026, 13:37 UTC (~7 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5173 (custom Vite plugin pins the port)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`
**Current branch:** `debug/dof-only` — stacked on `feat/seam-investigation` → `feat/seam-weld` → `feat/grass-from-ground` → `feat/grass` → `main`. **None merged.** Now FIVE unmerged branches.

## Canonical reads (in order)

1. `PHASE_1.md` — 15-day plan + stack + cut order.
2. `THESIS.md` — full game design.
3. `BLENDER_PIPELINE.md` — authoring contract (face-block layout, subdivision rules, animation compat).
4. `blender-plugin/README.md` — addon install, panel walkthrough.
5. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — **`project_architecture_day15.md` is the CURRENT snapshot** (day14.md is SUPERSEDED). Also read `feedback_dof_integration.md` (three simultaneous rules for DoF), `feedback_blender_pipeline.md`, `feedback_shader_patches.md`, `feedback_library_ref_attachment.md`.
6. `.anvi/` catalogues — `hetvabhasa.md` P1–P25, `vyapti.md` PV1–PV13, `krama.md` PK1–PK5, `dharana.md` (B2 FATAL @ 4 patterns, **B4 FATAL @ 4 patterns**).

## Where we are

**Five unmerged branches stacked.** `main` still has only Day 11 content. Everything below rides on top.

### `feat/grass` — meadow + Blender round-trip + Live Mode + addon
### `feat/grass-from-ground` — grass authoring from the ground
### `feat/seam-weld` — Phase A + sphere seam fixes + classic rubik view
### `feat/seam-investigation` — classic rubik view + Blender Init + Day-14 DoF/grass work
### `feat/debug/dof-only` (current) — DoF PERCEPTION SOLVED (Day 15)

**Day 15 — DoF finally works perceptually.** Required three fixes, all applied on this branch:

1. **P24 — force-bind depth, bypass EffectComposer.** Day-14's P21 `gl_FragDepth` write from the composite quad wasn't reaching postprocessing's CoC-sampled DepthTexture. Symptom: DoF uniforms probed correct, but only `bokehScale` changed the output. Fix: `useFrame(() => effect.setDepthTexture(sphereTarget.depthTexture))`. Publish `sphereTarget.depthTexture` through `hudUniforms.uSphereDepth` so PostFx can read it from outside TileGrid.

2. **P25 fix — screen-space aperture mask.** Depth-based DoF on a convex planet focuses at scalar depth, which on a sphere corresponds to an intersection-of-spheres CIRCLE, not a point. Result: hovering the cursor produced a focus RING, not a focus spot. Fix: patch `cocMaterial.fragmentShader` via string-replace — `magnitude = max(depthCoC, smoothstep(sharpR, blurR, length((vUv - cursorUv) * vec2(aspect, 1))))`. Uniforms written per frame from projected `dofTarget`; idempotent (`mat.userData.__cocPatched`); re-applied on wrapper re-instantiation via `lastPatchedMat` ref.

3. **Front-pole off-cursor target.** When cursor is off planet, target was at origin → focus depth = cameraDistance → focal plane intersected planet at the silhouette rim → visible center blurred. Fix: target = `normalize(camera.position) * planetRadius` (front pole). Focus depth = cameraDistance − R → closest visible surface. With rangeWholePlanet=20m ≫ planet depth variation ≈ 2m, whole planet reads sharp.

Infra added this day:
- `src/DOFtest.tsx` — minimal-scene DoF diagnostic route, proved the prop-path works in isolation (narrowed failure to composite/depth chain). Served at `http://localhost:5173/DOFtest/` via pathname gating in `src/main.tsx`.
- `PLANET_SPHERE` exported from `Interaction.tsx`, radius default 1.05, live-tunable via `focus surface R` Leva slider. Raycast sphere sits at grass canopy — DoF target lands on visible surface.
- **PostFx was STRIPPED** of every effect except DoF to isolate the diagnosis. SMAA, N8AO, SSAO, Bloom, Noise, Vignette, RealismFX — all gone. This branch ships with DoF only.

## 🔴 FIRST TASKS — pick one

### Option A — Re-integrate stripped effects, then ship
Day 15's DoF-only PostFx was a diagnostic step. Before merging, reinstate SMAA/N8AO/SSAO/Bloom/Noise/Vignette/RealismFX alongside the Day-15 fixes. Verify DoF still works with the full chain. Then merge `debug/dof-only` → `feat/seam-investigation` → `main` as one big stack. ~2-3 hours.

### Option B — Ship the stack as-is (risky)
Merge `debug/dof-only` straight to main with DoF only. Other effects disappear from the live build. Simplest aesthetic, less to go wrong, but loses Bloom warmth, AO grounding, SMAA edges, etc. Only viable if we decide the simpler look is what we want for the jam.

### Option C — DoF tuning pass
Defaults on the branch are conservative (`screen sharp R = 0.08`, `screen blur R = 0.30`, `bokeh = 4`). For a photo-style shallow focus: `sharp ~0.15`, `blur ~0.40`, `bokeh ~6`. Tune to taste, set new defaults, commit. ~30 min. Can do in parallel with A or B.

### Option D — Audio pass
Howler still unwired. Ambient wind, slice-rotation click, settle chime, walk-mode footsteps. ~1 day.

### Option E — Per-cell visibility culling
`.anvi/todos.md` MEADOW_PERF_CULLING. ~6× draw-call reduction on glb scenes.

### Option F — Bundle split
~850 KB gzipped. Split drei/three/realism-effects/lottie into lazy chunks.

My lean: **A first** (re-integrate so we don't ship a gutted PostFx to the jam build) → **C** (tune the aperture defaults) → **D** (audio). The jam deadline is ~7 days out; spending 2-3 hours on A to preserve the full visual stack is worth it.

## Hard invariants (don't change without reading catalogues)

PV1, PV6, PV7, PV8, PV9, PV10, PV12, PV13 still hold. PV11 (updated Day 14) still holds.

**NEW invariant candidates (not yet codified in vyapti.md):**
- **DoF depth source must be force-bound.** When an offscreen custom render path feeds EffectComposer, the composer's depth chain is unreliable. Call `effect.setDepthTexture(sourceDepth)` per frame, bypassing composer-managed depth wiring. Canonical in `src/world/PostFx.tsx`.
- **DoF target off-cursor = front pole, not origin.** `normalize(camera.position) * planetRadius`.

New hetvabhasa entries this day: **P24** (composite gl_FragDepth → EffectComposer depth chain broken; force-bind via setDepthTexture), **P25** (depth-based DoF on convex surface produces focus ring; fix with screen-space aperture patch).

Dharana boundary status:
- **B2** (R3F ↔ postprocessing EffectComposer) — FATAL, 4 patterns clustered (P4, P6, P7, P22).
- **B4** (offscreen composite ↔ depth-dependent post-effects) — FATAL, **4 patterns** clustered (P8, P21, P23, P24). The "strongest smell" at B4 is now "uniforms probe correct but GPU output behaves as if they're at defaults" — default response = force-bind textures directly to effect materials.

## Working style

- Concise. 1–2 sentence end-of-turn.
- **Observation over inference.** Runtime probes BEFORE claiming a fix works. For DoF specifically, "uniform probe correct" is NOT proof of "effect works" — check the visual response to focusRange/focusDistance sliders independently. If only bokeh changes output, depth chain is broken regardless of what uniform probes say.
- Options-not-implementations before non-trivial work.
- Playwright for verification; screenshots to `/tmp/rubics-test/`. CDP `Page.captureScreenshot` bypasses Playwright's font-load wait when the page has a live WebGL canvas. Headless Playwright on SwiftShader is too slow for our scene — verify in the real browser.
- Commits: gitmoji + `Problem:` / `Fix:` body. No `Co-Authored-By`.
- Always-deployable main. Ship in sequence.
- Catalogues + memory stay in sync; new pattern → catalogue entry before moving on.

## Start by

1. `git status` — should be clean on `debug/dof-only` (or have uncommitted Day-15 work ready to commit).
2. `git log --oneline main..HEAD` — confirm the stack (~40+ commits).
3. Verify DoF still works in http://localhost:5173 — hover on planet, sharp circle around cursor, no ring, no uniform blur. Off planet, whole planet mostly sharp.
4. Pick an option above. Lean: **A** (re-integrate stripped effects) first.

---

*End of handoff prompt.*
