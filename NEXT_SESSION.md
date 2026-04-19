# New-session handoff prompt — Rubic's World (end of Day 9, intro cinematic merging)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — my solo entry for levelsio's **Vibe Jam 2026**.

**Deadline:** 1 May 2026, 13:37 UTC (~9 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5176 (port drifts)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`

## Canonical docs (read in this order)

1. `PHASE_1.md` — 15-day plan, scope, stack, cut order, gates.
2. `THESIS.md` — full game design.
3. `BLENDER_PIPELINE.md` — glTF authoring pipeline when we move diorama into a .glb file.
4. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — `project_architecture_day9.md` is the CURRENT architecture. Also read `feedback_shader_patches.md`, `feedback_per_frame_scene_push.md`, and `feedback_strict_mode_guard.md` — three hard-earned rules.
5. `.anvi/` catalogues in the repo — `hetvabhasa.md` has P1 (geometry subdivision), P2 (per-frame scene push), P3 (Strict Mode guard). `vyapti.md` has PV1–PV2.

## Where we are

All Day 6–9 work is either merged to main or in review. PRs shipped today:
- PR #8 — Day 6–8 bundle (sphere pipeline, cross cube-net, diorama content, HDRI panel, PBR)
- PR #9 — Rotation affordance (keyboard input + yellow-line HUD + easy-mode hints)
- PR #10 — Walk mode (first-person + HDRI per-frame-push fix)
- PR #11 — **Intro cinematic** (open at time of writing — solved orbit → scramble → yield on hover)

Current main is always deployable.

### Day 9 work (all shipped or in PR)

- **Keyboard rotation hybrid** — hover a tile + Q/W/E/A/S/D. Face-local axes; same `rotateAnimated` pipeline as drag.
- **Yellow line HUD** on terrain. Thin lines at cube face-boundary edges (cosmetic — within-cubie seams). Thick lines at face-internal seams (the three slice-shear great circles). Corner-fade suppresses 3-face-junction speckle. Global attract-opacity covers the planet at t=0, fades to cursor-reactive after first commit.
- **Easy-mode correctness colors** — Leva toggle. Lines tint green (both tiles at home) or red (misplaced). Driven by `uHudTileEdgeMask[24]` computed each frame via static `NEIGHBOR_IDX`.
- **Walk mode** (`WalkControls.tsx`) — click "Walk on planet". First-person camera on surface, mouse-look + WASD. `fwdRef` is tangent-plane, `pitchRef` is a separate scalar (clamped ±86°) so drift-correction doesn't wipe pitch. No pointer-lock → HDRI/Leva panels remain interactive while walking. Tab/Esc exits, camera pulls back to radius 4.
- **HDRI scene-property push moved to `useFrame`** — fixes silent revert whenever drei `<Environment>` or `<OrbitControls makeDefault>` writes scene defaults during sibling mount. See `feedback_per_frame_scene_push.md`.
- **Intro cinematic** (`IntroCinematic.tsx`) — on every page load: 2.8 s solved-planet hold with auto-orbit → animated scramble (18 moves) → continued auto-orbit of the scrambled state → first hover/drag/key/walk hands off control. Store now starts with `buildSolvedTiles()` + empty history; intro drives the first scramble.

## 🔴 FIRST TASK — once PR #11 is merged

Pick one:

### Option A — Audio pass (recommended)
Howler is in deps, nothing wired. Big atmospheric return per hour:
1. **Ambient loop** — soft low drone or nature-ish bed under the planet. Volume low, loops seamlessly.
2. **Slice rotation clicks** — short hollow-wood click on each `rotateAnimated` start or commit. Pitch-vary per axis so the ear learns which axis rotated.
3. **Settle chime** — single tone on `planet:settled` event (already dispatched from `store.ts::applyRotation` when solving). Warmth cue layered with the PostFx bloom ramp.
4. Optional: footstep click in walk mode every ~N units of travel.

Plan it as a `src/world/Audio.tsx` component that subscribes to store events. Keep all samples under 50 KB so they don't blow the bundle further.

### Option B — Walk-mode polish
1. **Auto-enter walk on orbit zoom-past-minDistance** — per original spec. Watch camera distance; when it dollies to the `minDistance` boundary, flip `cameraMode = 'walk'`.
2. **Crosshair** — tiny HTML overlay at screen centre while walking. Helps aim when interacting with things.
3. **Collision with diorama objects** — basic radial push-back from hut/windmill/trees/well/bridge. Reuse the `FLOCK_OBSTACLES` list in `buildDiorama.ts`.
4. **Orient WASD by look-direction** — currently walks along tangent forward; could feel more natural if walk-direction follows the pitched look instead (on ground, same thing; on slopes, different).

### Option C — Bundle size
1.75 MB → 556 KB gzipped. Vite flags >500 KB. Easy wins: code-split drei's Environment helpers, lazy-load PostFx, chunk three.js. Own phase; non-blocking.

### Option D — Per-tile biomes
The HUD's hard-mode correctness signal requires visually-distinct content per face (desert/ice/forest etc.). Big content pass. Probably post-jam.

## Other open items

1. **Bundle > 500 KB warning** — see Option C.
2. **Mobile/touch** — walk mode is desktop-only. Phone tap-and-drag to rotate works (pointer events), but no walk fallback. Flag for post-jam if judges complain.
3. **Starlings occasionally appear as pink dots near HDRI sunset** — their white base material + warm HDRI. Cosmetic, low priority.
4. **3-face corner speckle in HUD** — `cornerFade` smoothstep already mitigates, but not fully eliminated at extreme zoom. Polish-phase fix.
5. **Intro replay on reload** — currently plays every time. If that feels stale after a few playthroughs, gate on localStorage (`introSeen`).
6. **OrbitControls `autoRotate` keeps going after intro ends** (actually it doesn't — `SphereCamera` gates `autoRotate={introPhase !== 'done'}`). No action needed, just a verified invariant.

## Hard invariants (don't change without asking)

**From Day 8** (still live):
- `includeTerrain: mode !== 'sphere'` — sphere mode uses the global SphereGeometry terrain; per-tile terrain reintroduces seams.
- Idempotent `onBeforeCompile` patchers — shared materials break silently without the `__*Patched` guard.
- `uTileOriInv` is `Float32Array(96)`, not `Vector4[]`.
- Slice uniforms + orientation array written BEFORE `gl.render(terrainScene, camera)` in `TileGrid.useFrame`.
- `v = (dot(P, fUp) > 0) ? 0 : 1` — inverted v convention in `computeTileIdx`.
- Sphere shader normal fix: `mat3(viewMatrix) * sphereNormal`, NOT `normalMatrix`.
- Cross cube-net layout — rectangular 2×3 can't fold cleanly.
- Road subdivided to 64 widthSegments — unsubdivided long boxes chord through the sphere.
- Drag-direction picks axis, ring-hidden-by-default, 6.5° commit threshold, 2×2 topology.

**New in Day 9:**
- **Scene-shared state pushes every frame**, not in store-dep useEffect. See `HDRIEnvironment.useFrame` and vyapti PV2.
- **Walk-mode forward is decomposed into tangent `fwd` + scalar `pitch`.** Don't merge them; drift correction on fwd would wipe pitch.
- **OrbitControls unmounts during walk** — `SphereCamera` returns `null` when `cameraMode === 'walk'`. They can't coexist.
- **IntroCinematic uses store-state gate, not ref-guard.** Strict Mode double-invoke + `startedRef` silently no-ops timed sequences. See hetvabhasa P3 / `feedback_strict_mode_guard.md`.
- **Initial tiles are SOLVED** — intro drives the first scramble. Changing this requires an intro rewrite.

## Working style

- Concise. 1–2 sentences end-of-turn.
- Brainstorm → option matrix → pick before non-trivial work.
- Playwright for anything non-trivial to verify; screenshots to `/tmp/rubics-test/`.
- Commits: gitmoji + `Problem:` / `Fix:` body, no `Co-Authored-By`.
- Always-deployable main. Ship branches in sequence, not stacked.

## Start by

1. Confirm PR #11 is merged and main is synced.
2. Pick Option A (audio) or B (walk polish) based on how the last playthrough felt.
3. For A: new branch `feat/audio`, new component `src/world/Audio.tsx` subscribing to store / planet events.
4. For B: new branch `feat/walk-polish`, extend `WalkControls.tsx` + a new `useCameraDistanceWatcher` in `App.tsx`.

---

*End of handoff prompt.*
