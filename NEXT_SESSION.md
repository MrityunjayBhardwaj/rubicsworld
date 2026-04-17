# New-session handoff prompt — Rubic's World (Day 6 continued)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — my solo entry for levelsio's **Vibe Jam 2026**.

**Deadline:** 1 May 2026, 13:37 UTC.
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → localhost (port varies, check output)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`

## Canonical docs (read in this order)

1. `PHASE_1.md` — the authoritative 15-day plan, scope, stack, cut order, gates.
2. `THESIS.md` — full game design.

## Where we are

Days 1–5 shipped. Day 5 added scramble-on-load, warming light, bloom/vignette, AI seed.

Day 6 is IN PROGRESS — we built the diorama-to-sphere pipeline. The pipeline works end-to-end but has known issues to fix.

### The diorama pipeline (read these files)

```
src/diorama/
  buildDiorama.ts    — imperative Three.js scene builder (terrain, water, hut, windmill, trees, etc.)
                       BASE_W=4, BASE_H=6, each cell 1×1. Returns { root, update(elapsed) }
  DioramaGrid.tsx    — flat grid overlay view. Exports COLS=4, ROWS=6, CELL=1, cellFace()
  TileGrid.tsx       — THE RENDERER. Modes: split | cube | sphere.
                       Takes over render loop (useFrame priority=1).
                       Renders ONE diorama 24 times with different clip planes.
                       Sphere mode: cube clip planes + vertex shader sphere projection.
  BezierCurveEditor.tsx — draggable bezier curve for height mapping (bottom-left UI)
  Diorama.tsx        — JSX version (Triplex compatibility only, not used at runtime)
```

### How the pipeline works

1. **Grid**: 4×6 flat diorama, 24 cells of 1×1. Each cell maps to a cube face tile.
2. **Split**: same 24 cells, separated with gaps, rendered through 3D clip planes (like Blender Alt+B).
3. **Cube**: cells folded onto cube faces. 8 clip planes per tile (4 within-face + 4 face-boundary).
4. **Sphere**: cube clip planes + `onBeforeCompile` vertex shader that additively curves geometry to sphere surface. Height decomposed via `dot(worldPos, faceNormal) - 1.0`, then passed through a bezier curve.

Face mapping: 4×6 grid → 6 faces as 2×2 blocks. `cellFace()` and `FACE_TO_BLOCK` handle bidirectional mapping. Store tiles map via `storeTileCubeRender()`.

### What's working

- Grid / Split / Cube views (Leva buttons)
- Sphere view (default planet) with additive curvature vertex shader
- Store integration: Scramble/Reset buttons reposition tiles correctly
- Animations: windmill spins, trees sway, water ripples — all through the same diorama scene
- Bezier curve editor for height mapping tuning

### Known issues to fix NEXT

1. **Black base plane not visible on sphere** — the base PlaneGeometry (32×48 segments) at Y=-0.001 might need the sphere shader applied. Investigate if `patchSceneForSphere` actually patches it.

2. **Drag interaction not wired** — the Interaction.tsx component is in the scene but can't interact with the diorama sphere (no raycasting targets). Need invisible proxy geometry or raycasting against the unit sphere.

3. **PostFx disabled** — bloom + vignette (PostFx.tsx) fight with the custom render loop. Need to integrate or render post-fx after the portal passes.

4. **Cap/fill at clip boundaries** — when objects are clipped, hollow interiors are visible. All three approaches (geometry, shader, stencil) were discussed and rejected during brainstorm. Revisit or accept.

5. **Face seams** — content discontinuity at cube face boundaries is inherent to the 2×3→cube mapping. The 4×6 grid doesn't fold into a seamless cube net.

### Things NOT to change without asking

(Same as Day 4 — see NEXT_SESSION.md history in git. Plus:)
- **Clip-plane approach for tile splitting** — user explicitly chose this over stencil portals and shader discard. Don't switch.
- **Additive sphere projection (not normalize)** — height must be preserved, not squashed.
- **4×6 grid with 1×1 cells** — scaled up from 0.5. Each cube face = 2×2 = 4 tiles.
- **ONE diorama rendered 24 times** — no cloning, no splitting geometry. The scene is re-rendered with different clip planes and transforms per tile.

### Working style expected

- Concise. 1–2 sentences end-of-turn on what changed + what's next.
- Brainstorm before implementing when user asks.
- Test with Playwright when behaviour is non-trivial. Screenshots to `/tmp/rubics-test/`.
- Commit messages follow gitmoji + `Problem:` / `Fix:` body. No `Co-Authored-By`.
- Always-deployable state is a hard rule.

Start by reading `src/diorama/TileGrid.tsx` and `src/diorama/buildDiorama.ts` in full, then confirm what you see and ask what to work on.

---

*End of handoff prompt.*
