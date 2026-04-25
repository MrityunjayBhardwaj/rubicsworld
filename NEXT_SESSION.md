# New-session handoff prompt — Rubic's World (Day 17.5: 5 commits on features-and-fixes + parked spring-bend prototype; AUDIO is the next focus)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — solo Vibe Jam 2026 entry.

**Deadline:** 1 May 2026, 13:37 UTC (~5–6 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → http://localhost:5173
**Bake offline:** `node bake-diorama.mjs`
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`
**Current branch:** `features-and-fixes` — 5 commits ahead of `main`, **NOT pushed yet**, plus 5 uncommitted files for a parked spring-bend prototype.

## Canonical reads (in order)

1. `PHASE_1.md` — 15-day plan + stack + cut order.
2. `THESIS.md` — game design.
3. `BLENDER_PIPELINE.md` — authoring contract.
4. Memory: `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — **`project_architecture_day17_5.md` is the current snapshot**. Also read `feedback_glsl_file_scope.md` (new), `feedback_dof_integration.md`, `feedback_shader_patches.md`, `feedback_library_ref_attachment.md`.
5. `.anvi/` catalogues — hetvabhasa P1–P40 (P39–P40 NEW: GLSL file-scope qualifier rule + mesh-local bend disconnects nested structures), vyapti PV1–PV17, krama PK1–PK7, dharana B2/B4.

## Where we are (Day 17.5 ⇒ session ended fresh)

### What landed locally (5 commits on `features-and-fixes`, NOT pushed)

```
275d74c 📝 docs: catalogue Day 17 patterns + handoff prompt refresh
666eda1 🚶 feat(walk): pointer-lock walk mode with three-gate collision
d901981 🍰 feat(bake): /bake/ route + Playwright driver + glb-as-canonical
03a8d2e ✨ feat(terrain): 3-layer vertex colors + sphere-terrain PBR forwarding
a819b5e ✨ feat(blender): two-collection model + role-tagged round-trip
```

### Spring-bend prototype — PARKED at /springy/ (5 uncommitted files)

- `src/world/springBendShader.ts` (NEW) — `attachSpringBend(mat, { uniforms })`. World-space bend in a `<project_vertex>` replacement. Idempotent (P31), chains prior `onBeforeCompile` (P7).
- `src/world/springStore.ts` (NEW) — k/c damped-spring integrator (semi-implicit Euler).
- `src/SpringyTest.tsx` (NEW) — `/springy/` scene: `GrassScene` + 3 procedural windmills with animated rotors. Each Windmill registers its own pivot/up/height; SpringDriver fans out shared world impulse from camera horizontal velocity each frame.
- `src/main.tsx` (MOD) — pathname gate added.
- `src/GrassTest.tsx` (MOD) — 1-line: `GrassScene` is now exported.

What works:
- Drag → windmills lean. Release → recoil + ring-down. Tunable k/c/drive/maxBend in Leva.
- Whole structure (pad → tower → cone → hub → spinning blades) bends as one piece around its surface base.

What's deferred:
- Normal rotation (lighting on bent surfaces is slightly off; clean fix is rewriting `vNormal` inline inside the `<project_vertex>` replacement gated on `#ifndef FLAT_SHADED`).
- Integration into the main /diorama scene (P8 risk — vertex displacement breaks N8AO normal reconstruction; needs disabling N8AO on bent materials or skipping bend on tiles routed through TileGrid composite).

### Public files (unchanged from Day 17)

```
public/
  diorama.glb          807 KB; 11 colliders, 2 anim tracks, named density layers
  grass-mask.png       grass exclusion mask
  flower-mask.png      flowers exclusion mask
  walk-mask.png        OPTIONAL — falls back to grass-mask
```

## 🔴 FIRST TASK — AUDIO

Howler is in `package.json` but unwired. Targets for the jam ship:

- **Ambient wind** — looped, low-mid layer; volume gently scales with grass-wind strength.
- **Slice rotation click** — short tick on each 6.5° threshold cross.
- **Settle chime** — soft single note when a slice eases into the cube alignment.
- **Walk-mode footsteps** — short pad blip per ~0.5m of walk-step distance traveled.
- **Jump SFX** — one-shot on Space.

Mental model: a single `src/world/audioBus.ts` exposes `play(event, opts?)` and a Leva audio panel for master/category mute + volume. Listeners wire into existing event sites (rotation controller, walk controller, slice store).

Before coding: `/anvi:discuss-phase` to nail down which sounds are stock vs. synthesized in-app, and where the master gain hooks into the existing visibility-pause and walk-mode-toggle gates.

## Hard invariants (don't change without re-reading catalogues)

PV1–PV17 hold. Notable for audio work:
- **PV12 family** — scene-shared state must be pushed every frame. Audio listener position (THREE.AudioListener attached to camera) is fine because it follows camera transform, but any per-frame gain ramps need useFrame, not useEffect.
- **P31 idempotency** — if any audio path patches a material (unlikely but possible for HUD overlays), keep the patch idempotent.

Spring-bend specific (don't break while doing audio work):
- **P39:** GLSL file-scope vars need a qualifier. Cross-chunk `onBeforeCompile` state lives in main() body, not file scope.
- **P40:** mesh-local bend disconnects nested structures. World-space bend is the right answer.

## Working style

- Concise. 1–2 sentence end-of-turn.
- **Observation over inference.** For audio: actually play it and listen, don't infer from waveform inspection alone.
- Options-not-implementations before non-trivial work.
- Commits: gitmoji + `Problem:` / `Fix:` body. No `Co-Authored-By`.
- Always-deployable main. `features-and-fixes` is a stash branch — push only after the spring prototype is either committed or stashed.
- Catalogues + memory stay in sync; new pattern → catalogue entry before moving on.

## Start by

1. `git status` — should show 5 untracked/modified files for the spring prototype.
2. `git log --oneline main..HEAD` — confirm the 5 commits are still there.
3. Decide: (a) commit the spring prototype as a 6th `🌱 feat(springy): prototype spring-bend...` chunk before audio, or (b) stash it and revisit after audio ships. **Lean: (a) — small commit, keeps the branch self-contained, prevents stash decay.**
4. Then: `/anvi:discuss-phase audio` to scope the audio pass.

---

*End of handoff prompt.*
