# New-session handoff prompt — Rubic's World (end of Day 11, PostFx Path 1 + Path 2 infra shipped)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — my solo entry for levelsio's **Vibe Jam 2026**.

**Deadline:** 1 May 2026, 13:37 UTC (~10 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5173 (port drifts)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`

## Canonical docs (read in this order)

1. `PHASE_1.md` — 15-day plan, scope, stack, cut order, gates.
2. `THESIS.md` — full game design.
3. `BLENDER_PIPELINE.md` — glTF authoring pipeline for when we move diorama into a .glb file.
4. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — `project_architecture_day11.md` is the CURRENT architecture. Also read `project_postfx_strategy.md`, `feedback_library_ref_attachment.md`, `feedback_library_patch_package.md`.
5. `.anvi/` catalogues in the repo — `hetvabhasa.md` P1–P8, `vyapti.md` PV1–PV5, `krama.md` PK1–PK2, `dharana.md` (three new boundaries logged in this session).

## Where we are

All Day 6–11 work is merged to main. PRs shipped so far:
- **PR #8** — Day 6–8 bundle (sphere pipeline, cross cube-net, diorama content, HDRI panel, PBR)
- **PR #9** — Rotation affordance (keyboard input + yellow-line HUD + easy-mode hints)
- **PR #10** — Walk mode (first-person + HDRI per-frame-push fix)
- **PR #11** — Intro cinematic (solved-orbit → scramble → yield on hover)
- **PR #13** — **Onboarding tutorial** (guided 3-move solve with directional arrow + Lottie hint + BFS re-solve)
- **PR #15** — **PostFx Path 1 + Path 2 infra** (pmndrs stack + realism-effects SSGI/SSR/motion blur via patch-package; DoF cursor-follow; N8AO/SSAO dual exposure)

Main is always deployable.

### Day 11 work (shipped in PR #13 + PR #15)

**Onboarding tutorial** (`src/world/TutorialOverlay.tsx`, `src/world/tutorialSolver.ts`):
- First-visit gate on `localStorage.rubicsworld:tutorialSeen`
- Deterministic 3-move scramble → `introPhase='tutorial'` → additive yellow arrow on demo tile pointing along rotation tangent + floating Lottie hand via drei `<Html>` + "Swipe the glowing tile — N of M" chrome
- BFS re-solve (depth ≤ 5) on wrong moves; queue auto-rebuilt so hint re-points at shortest path
- Skip: Esc / skip-button / walk-mode entry. Flag written on completion or skip.
- Repeat visits run the original 18-move attract, untouched
- Placeholder Lottie (`src/world/assets/swipe-hint.json`) — hand-authored pulsing dot, **swap before ship**

**PostFx Path 1** (`src/world/PostFx.tsx`):
- Full chain: SMAA → N8AO → SSAO → DoF → Bloom → Noise → Vignette
- All 50+ params exposed in a `PostFx` Leva folder (sub-folders per effect)
- DoF follows cursor hit on planet, eases to planet center off-planet, via per-frame self-healing ref attach (see below — was a 3-root-cause bug hunt)
- N8AO + SSAO are peers. N8AO is default-on but produces no visible AO on our scene (see Known issues below); SSAO is default-off and available as the working alternative

**PostFx Path 2 infra** (`src/world/RealismFX.tsx` + `patches/realism-effects+1.1.2.patch`):
- realism-effects SSGI + SSR + motion blur verified working on three 0.183
- 5-round patch-package patch auto-applied via `postinstall: patch-package`:
  1. `WebGLMultipleRenderTargets` → `WebGLRenderTarget({ count })` (removed r163)
  2. `.texture[i] / .map / .push / .length / Array.isArray` → `.textures.*`
  3. `copyFramebufferToTexture(pos, tex)` → `(tex, pos)` (r163 arg swap)
  4. `OptimizedCineonToneMapping` → `CineonToneMapping` (GLSL rename r163)
- Escape hatch: consumes `EffectComposerContext`, adds one EffectPass per realism effect (merging collides on `tonemapping_pars_fragment` chunk inclusion — hetvabhasa P7)
- All realism effects default OFF — earn their keep when photoreal Blender diorama lands
- `sceneGrade: 'stylized' | 'photoreal'` store flag plumbed for the switch

**Renderer config** (`src/App.tsx`):
- `gl={{ antialias: false, stencil: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.35 }}`
- EffectComposer: `multisampling={0}`, `stencilBuffer`, `depthBuffer`

## 🔴 FIRST TASKS — pick one

### Option A — Audio pass (still highest ROI)
Howler is in deps, nothing wired. From Day 9 handoff:
1. Ambient loop — low drone under planet
2. Slice rotation clicks per axis (pitch-varied) on `rotateAnimated` commit
3. Settle chime on `planet:settled` event
4. Optional: walk-mode footstep clicks

Plan as `src/world/Audio.tsx` subscribing to store events. Samples < 50 KB each.

### Option B — Swap the placeholder Lottie
`src/world/assets/swipe-hint.json` is a hand-authored pulsing dot. Replace with a designed swipe-hand Lottie (LottieFiles asset or custom). Drop in same path; no code change.

### Option C — Bundle split (getting more pressing)
Bundle ~850 KB gzipped after Path 1 + realism-effects + lottie. Vite flags >500 KB. Before photoreal Blender diorama lands (will add more). Code-split drei/three/realism-effects/lottie into lazy chunks.

### Option D — Walk-mode polish (deferred from Day 9)
Auto-enter walk on orbit zoom-past-minDistance, crosshair overlay, collision with diorama props, look-direction WASD orientation.

### Option E — Photoreal Blender diorama
Trigger for Path 2 activation. When this asset lands in repo: load alongside stylized test diorama; flip `sceneGrade='photoreal'`; enable realism-effects toggles; re-test N8AO (likely starts working on standard geometry).

## Other open items

1. **N8AO produces no visible AO on our planet** — sphere-projection vertex shader creates depth micro-discontinuities that defeat N8AO's neighbour-delta normal reconstruction. SSAO is the workaround (exposed in Leva). Likely resolves when photoreal Blender diorama arrives. See hetvabhasa P8, `.anvi/todos.md` N8AO_SPHERE_INCOMPAT.
2. **Bundle size >500 KB** — tracked in `.anvi/todos.md` BUNDLE_SPLIT.
3. **Headless Chromium FPS** tanks on full effect chain (SwiftShader). Tutorial test timeout bumped to 60 s. Real browsers unaffected.
4. **Mobile/touch** — walk mode desktop-only. Post-jam flag.
5. **Starlings pink-dot artifact** — cosmetic, low priority.

## Hard invariants (don't change without asking)

**From Day 8-9** (still live):
- Sphere-mode uses global SphereGeometry terrain; `includeTerrain: mode !== 'sphere'`.
- Idempotent `onBeforeCompile` patchers with `__*Patched` guard.
- `uTileOriInv` is `Float32Array(96)`, not `Vector4[]`.
- Slice uniforms + orientation array written BEFORE `gl.render` in `TileGrid.useFrame`.
- Scene-shared state pushed every frame, not in store-dep useEffect (vyapti PV2).
- Walk-mode `fwd` (tangent) + `pitch` (scalar) — don't merge.
- OrbitControls unmounts during walk.
- IntroCinematic uses store-state gate, not ref-guard (hetvabhasa P3).
- Long geometry needs subdivision (vyapti PV1).

**New in Day 11:**
- **Tone mapping on renderer, NEVER in effect chain** (vyapti PV4). Effects expect linear input.
- **Canvas+Composer config recipe** (vyapti PV5): `antialias: false` + `multisampling: 0` + `stencilBuffer` + `depthBuffer`. SMAA in effect chain replaces MSAA.
- **Mutable-ref props on postprocessing wrappers need per-frame re-attach**, NOT useEffect (vyapti PV3). Canonical pattern in `feedback_library_ref_attachment.md`. Canonical instance: DoF target in PostFx.
- **SSGI + SSR can't share an EffectPass** (hetvabhasa P7). Each lands in its own.
- **realism-effects needs patch-package** on three 0.183 (hetvabhasa P5). Auto-applied via postinstall.

## Working style

- Concise. 1–2 sentences end-of-turn.
- Options-not-implementations before non-trivial work; wait for call.
- Playwright for verification; screenshots to `/tmp/rubics-test/`.
- Commits: gitmoji + `Problem:` / `Fix:` body, no `Co-Authored-By`.
- Always-deployable main. Ship branches in sequence.
- Catalogues and memory in sync — when a new pattern emerges, log it before moving on.

## Start by

1. Pull latest main (PRs #13 + #15 merged).
2. Pick an option above (lean: A — audio has the highest atmospheric ROI per hour; or B — quick visual polish on the tutorial Lottie).
3. New branch prefixed per convention (`feat/audio`, `feat/lottie-swap`, etc.).

---

*End of handoff prompt.*
