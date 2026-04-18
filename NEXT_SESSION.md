# New-session handoff prompt — Rubic's World (end of Day 6–7 HDRI/cube-net branch)

Copy the block below into the next session verbatim.

---

We're continuing **Rubic's World** — my solo entry for levelsio's **Vibe Jam 2026**.

**Deadline:** 1 May 2026, 13:37 UTC (≈13 days out)
**Live URL:** https://rubicsworld.vercel.app (auto-deploys on `git push origin main`)
**Repo:** https://github.com/MrityunjayBhardwaj/rubicsworld
**Local dev:** `npm run dev` → localhost (usually 5175)
**Working dir:** `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`

## Canonical docs (read in this order)

1. `PHASE_1.md` — the authoritative 15-day plan, scope, stack, cut order, gates.
2. `THESIS.md` — full game design.
3. Memory files in `~/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-RubicsWorld/memory/` — auto-loaded, but the current architecture is `project_architecture_day6_7.md` (not the Day 5-6 one).

## Where we are

Days 1–5 shipped. A huge Day 6–7 feature/polish branch has landed **locally** but is **not yet merged**.

Branch: `fix/day6-sphere-polish` — 20 commits ahead of `main`. Should PR before starting anything substantial.

### What the branch did (high level)

- **Sphere render pipeline:** drag + anim wired in (live slice preview + settle); PostFx via offscreen `useFBO` + fullscreen quad; commit-pop fixed via `tile.orientation` in the root quaternion; shader `height` → `normalizedH` bug fix.
- **Puzzle semantics:** `Solve` and `Solve (animated)` buttons; `solveAnimated` replays inverse moves from a tracked `history` in reverse; `isSolved` is now **Visually-Solved** (shared-orientation + centroid match) so global cube rotations count as solved.
- **Layout:** replaced the 4×6 rectangular flat diorama with a **cross cube-net** (8×6 bounding box, 24 filled cells). Every flat-adjacent cell maps to a cube-adjacent cell and the seam cells line up — seam-crossing objects and continuous textures work cleanly now.
- **Labels:** `TileLabels` component in all 4 views (grid/split/cube/sphere) with per-face letter+index scheme (`A1..F4`), per-face outline colours, and an HTML legend panel. Labels 3/4 on the top row of each face, 1/2 on the bottom (user-approved convention).
- **V-axis convention:** flipped at the source (`tileCentroid` / `centroidToFaceUV`) so `v=0 = physical top`. Cascaded through all vOff consumers + `tileToHome`.
- **Cube view row swap** (inside `cubeCellRender`, `buildOverlayLines`, `CubeLabels`) is balanced with sphere's `tileToHome` so sphere matches cube on which content sits at each physical position. Don't "simplify" one without the other.
- **Menu:** Leva entries renamed to `View: Cube net / Split / Cube / Sphere (planet)`.
- **Terrain:** black base plane removed. Seamless grass texture (procedurally tileable, periodic sin/cos) with world-space UVs at 0.5 rep/unit (1 texture repeat per 2-unit face-block).
- **Lighting:** HDRI IBL via drei's `<Environment>` + floating HTML `HDRIPanel` (upload `.hdr`/`.exr`, preview thumbnail via RGBELoader+Reinhard, preset dropdown, exposure/blur/rotation/BG-opacity sliders, collapse). `physicalLights` toggle mutes all direct lights → IBL only. `TileGrid` mirrors `scene.environment` onto its offscreen `dScene` each frame so the diorama gets IBL too.
- **Camera:** `TrackballControls` for sphere mode (quaternion-based, seamless 360° — no Y-pole lock). `OrbitControls` retained for preview modes (pan-by-right-click).

### Files currently live

```
src/diorama/
  buildDiorama.ts         — cross-net, grass, 13 object builders, BASE_W=8
  DioramaGrid.tsx         — COLS=8 ROWS=6, cellFace returns -1 for padding,
                            FACE_TO_BLOCK_TL exported
  TileGrid.tsx            — split/cube/sphere modes, takes over render loop,
                            sphere → offscreen FBO + fullscreen quad,
                            drag/anim/slice-rotation, env sync for dScene

src/world/
  rotation.ts             — AXIS_VEC, tileCentroid (v-flipped), centroidToFaceUV, rotateSlice
  tile.ts                 — buildSolvedTiles, VS-style isSolved
  store.ts                — zustand: tiles, history, drag/anim, solve/solveAnimated,
                            scrambleInstant/Animated, reset, VS event dispatch
  TileLabels.tsx          — all 4 modes + legend HTML overlay
  hdriStore.ts            — HDRI state
  HDRIEnvironment.tsx     — drei Environment wrapper, live param sync
  HDRIPanel.tsx           — floating HTML: upload, preview, sliders
  Ring.tsx, Interaction.tsx, AiSeed.tsx, PostFx.tsx

src/
  App.tsx                 — Canvas + mode routing, TrackballControls in sphere,
                            OrbitControls in preview, HDRIEnvironment + HDRIPanel mounted
  Controls.tsx            — Leva menu
```

## Hard invariants (things NOT to change without asking)

- **Cross cube-net layout** — reverting to 4×6 rectangle breaks every seam invariant.
- **V-flip + tileToHome as a pair** — balanced. If you change one, change the other and every vOff consumer.
- **Cube-view row swap** — balanced with sphere's tileToHome so they match.
- **Label formula `(1-v)*2+u+1`** — user-approved; 3,4 top, 1,2 bottom.
- **TrackballControls for sphere** — OrbitControls causes Y-pole stall by design.
- **`dScene.environment` mirror each frame** — without it, the diorama goes dark when HDRI is the only light.
- Earlier Day 4 calls remain: drag-direction picks axis (not hover); ring visible only on drag/anim; 6.5° commit threshold; standard 2×2 topology.

## Known open items

1. **Branch is unmerged.** 20 commits on `fix/day6-sphere-polish`. Should PR → self-review → merge to main before adding more.
2. **Cap/fill at clip boundaries** — hollow interiors visible when objects clip. All three approaches (geometry, shader, stencil) were discussed and rejected earlier. Revisit or accept.
3. **Day 7 walk mode** per PHASE_1.md — not started. This is the clip-worthy moment ("oh, I can just walk around now"). Biggest remaining gate.
4. **Audio pass** — Howler in deps, no sounds wired yet.
5. **Intro/first-60s framing** — no HUD, no tutorial, but the game needs to communicate what to do in its first 60s.

## Working style expected

- Concise. 1–2 sentences end-of-turn on what changed + what's next.
- Brainstorm → option matrix → pick, before implementing anything non-trivial.
- Test with Playwright when behaviour is non-trivial. Screenshots to `/tmp/rubics-test/`.
- Commit messages: gitmoji + `Problem:` / `Fix:` (or feature intent) body. No `Co-Authored-By`.
- Always-deployable main is a hard rule; the current branch should be shipped before bigger work starts.
- Convention changes belong at the source (the type/math/store), not at the display layer.

## Start by

1. Read `src/diorama/TileGrid.tsx` and `src/world/rotation.ts` in full.
2. Skim `src/world/store.ts` and `src/world/TileLabels.tsx`.
3. Ask what I want: (a) ship the branch via PR, (b) start Day 7 walk mode, (c) chip at open items (cap/fill, audio, intro), or (d) something specific I'll describe.

---

*End of handoff prompt.*
