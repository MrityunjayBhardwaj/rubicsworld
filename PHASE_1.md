# Rubic's World — Phase 1

## Vibe Jam 2026 MVP

**Deadline:** 1 May 2026 at 13:37 UTC
**Days available:** 15 (counting from today, 16 April 2026)
**Target audience:** levelsio, s13k\_, and their dev/indie jury
**Prize:** $20K gold, $10K silver, $5K bronze
**Rules recap:** web-only, no login, no loading screens, free, 90% AI-written code, one entry per person

---

## 1. Strategic Posture

### What the jury will reward

The jury is dev-first, ship-first, web-native. Pieter and s13k value:

- **Instant load.** Anything over 3 seconds loses them.
- **Clean web tech.** Bundle size, frame rate, mobile-tolerance (nice-to-have).
- **A clear hook in the first 60 seconds.** They will give the game 2–3 minutes before forming an opinion.
- **Screenshot/tweet-worthy single frame.** If they can't capture a striking still, it won't ride the wave.
- **Polish over feature count.** A small, complete thing beats a sprawling unfinished thing.
- **Something that feels like it couldn't exist before AI-coded games.** The jam is implicitly a benchmark for how far AI coding has come.

### The strategic bet for this game

Most entries will be fast-paced, arcade-y, high-stimulation. Our bet is the opposite: **a calm, visually striking game that lets you solve a planet and then just be on it.** Contrast wins attention in a field of sameness. The warm low-poly planet inside a ring is a strong screenshot. The "oh, I can just walk around now" moment is a compelling clip.

We do NOT try to ship the full five-planet thesis arc in 15 days. We ship one planet, fully, with a single seeded hint of the broader arc (the ring glowing once, a rocket visible but not flying, the inward feeling of "there is more here than this"). The thesis becomes the long game. The MVP proves the feel.

### What must not happen

- No tutorial text, no HUD clutter, no level indicators.
- No fake urgency (timers, combos, scores).
- No half-working feature added "because jams reward content." One cut feature that works is better than three that don't.
- No assuming the jury will read an about page. The game must speak for itself in 60 seconds.

---

## 2. Stack Decision

### Chosen stack

```
Framework:     React 18 + Vite + TypeScript
3D:            three + @react-three/fiber + @react-three/drei
State:         zustand
Animation:     @react-spring/three
Audio:         Howler.js
Physics:       none (kinematic player movement; no rigid bodies needed)
Backend:       Supabase (anonymous auth + Postgres; optional for MVP)
Hosting:       Vercel (free tier, Edge CDN, custom domain)
Asset auth:    Blender → glTF, Draco-compressed where useful
Visual editor: Triplex (scene/camera/light/object manipulation on top of R3F source)
Dev GUI:       Leva (live value tweaking for colors, bloom, fog, speeds)
Code:          Claude Code (writes and refactors the TypeScript/R3F source)
Domain:        rubicsworld.xyz or similar (~$3)
```

### Tooling split — why this combination

Code-only R3F development is slow for the exact thing this game needs most: visual iteration on camera placement, lighting, and scene layout. A verbal instruction like "move the camera left and tilt down" is ambiguous and wastes turns. The stack above splits responsibilities so each tool does what it's best at.

| Task | Tool |
|---|---|
| Gameplay logic (rotation math, solve detection, AI seed, state, networking) | Claude Code |
| Scene layout (camera position, light placement, object positioning) | Triplex |
| Live value tuning (bloom, fog, color, speeds, thresholds) | Leva |
| 3D models (cottage, tree, rocket, terrain tiles) | Blender → glTF |
| Shader parameter finalization | Leva first, then freeze into code |

Triplex reads and writes the same TypeScript source files that Claude Code edits, so there is no round-trip or export/import cycle. You drag the camera in Triplex; the JSX in `<PerspectiveCamera position={...}/>` updates; Claude Code sees the new position next request.

Leva controls are added inline in components during development (`const { bloomIntensity } = useControls(...)`) and the values are stripped in production builds. Drop it into any component you need to tune, remove the hook once values are frozen.

### Rationale (full)

**Why not Unity WebGL.** Disqualifying load times. Jam rule "almost instantly in the game" is violated by default Unity WebGL builds (20–50MB). Even heavily optimized Unity WebGL builds clear 8MB minimum. Non-starter.

**Why not Godot HTML5.** ~10MB WASM runtime before game content. Marginal. Possible but wastes cycles on optimization that Three.js gets for free.

**Why not PlayCanvas (re-examined with editor requirement).** PlayCanvas has a mature visual editor and a small web runtime (~500KB) — tempting once a visual editor is a hard requirement. But its code lives in a cloud IDE, which fights Claude Code: you lose the "refactor the whole codebase in one request" advantage, and AI fluency for PlayCanvas-specific APIs is measurably worse than for Three.js (smaller training corpus). Triplex gives us the visual-editor upside without sacrificing the Claude-Code-reads-my-source-files workflow. R3F + Triplex wins on both axes.

**Why not Babylon.js.** Technically comparable to Three.js; slightly better defaults for PBR, and the Babylon editor ecosystem exists. But Claude is measurably better at Three.js because training data is 5–10× larger. For a 15-day AI-coded jam, AI fluency is the load-bearing criterion. The Triplex equivalent for Babylon is less mature.

**Why Three.js + R3F specifically.**

1. Unmatched AI codegen quality. Cursor will one-shot complex R3F scenes that Babylon or native Three.js would require iteration on.
2. Mrityunjay's existing R3F muscle memory from the ZIS-101A showcase. Zero ramp-up.
3. With Vite + tree-shaking + Draco compression + code-split, initial bundle under 2MB is realistic. Time-to-interactive under 2 seconds on decent connections.
4. `@react-three/drei` gives us cameras, controls, helpers, post-processing — everything needed, pre-built.
5. `@react-spring/three` for smooth tile rotation animations.
6. The R3F declarative style means Claude can generate whole scenes as React components, which is its sweet spot.
7. Triplex works natively on R3F source files, giving full visual scene editing without leaving the codebase.

**Why Supabase (optional).** If we ship async flags, Supabase's anonymous auth + Postgres + realtime gives us persistence with ~30 minutes of setup. Free tier handles any plausible jam traffic.

**Why Vercel.** Free, instant deploys on git push, Edge CDN for global latency, custom domain support, zero config with Vite.

### Bundle budget

| Chunk | Budget | Notes |
|---|---|---|
| Three.js core | ~600KB gzipped | Unavoidable |
| R3F + drei + spring | ~200KB gzipped | Tree-shaken |
| App code | <300KB gzipped | Keep lean |
| Textures + models | <800KB combined | Draco-compress glTF, small JPEGs |
| Audio | <400KB | Ogg, short loops |
| **Total initial load** | **<2.5MB gzipped** | Under 2s on 10Mbps |

---

## 3. MVP Scope

### Must-ship (cannot cut)

1. **One planet (Meadow).** 2×2 cubesphere. 24 tiles.
2. **The ring HUD.** Visible around the planet. Responsive to input. Selects axis + slice. Rotates slices.
3. **Scramble at start.** Planet spawns scrambled. 20 random valid moves applied.
4. **Solve detection.** When all tiles match their home position + orientation, "planet settles" event fires.
5. **The settle moment.** Lighting warms. Ambient audio swells gently. Weather shifts subtly. The ring dims. A soft chord plays once.
6. **Post-solve exploration.** Camera switches from puzzle-view (orbit around planet) to walk-view (small character on the surface, third-person). Character can walk anywhere on the solved planet.
7. **Flag planting.** Press a key, plant a flag at current position. Flag stays. Visible in the world.
8. **Instant load.** Under 3 seconds to interactive on a decent connection.
9. **The rocket.** Present on the surface. Visible. Non-functional this phase. (It's a promise.)
10. **The AI seed.** Exactly one tile settles autonomously during the final third of the solve, with the warm pulse on the ring and the single low tone. Not explained. Not repeated. Just planted.

### Strong-stretch (ship if time)

- **Async flag persistence.** Other players' flags visible via Supabase. No auth wall.
- **Simple flute.** Press-and-hold for tones. Diatonic scale. Non-scoring.
- **Painting on rocks.** Click a rock face, draw a simple mark, persists locally.
- **Day/night cycle.** Slow, soft, automatic.
- **Music residue.** If async flags ship, this is trivial to add.

### Definitely cut for phase 1

- All planets 2–5.
- AI growth curve (only the one-tile seed).
- NPCs. No ex-solvers. No figures at all (except the player character).
- The rocket flying.
- The inward cave.
- Full audio palette beyond ambient + four or five SFX.
- Mobile support beyond "it probably works if the browser handles R3F."

### Cut order if behind schedule

Cut from the bottom:
1. Strong-stretch items first (painting, flute, day/night, music residue, async flags).
2. Then: walk-view → replace with orbit-view-only-but-with-atmospheric-shift.
3. Then: the AI seed → replace with a single "settle" visual flourish.
4. Never cut: scramble, solve, ring HUD, settle moment.

The must-ship core is: a planet you solve, and a moment where the world clearly becomes different because you solved it. Everything else orbits that.

---

## 4. 15-Day Schedule

Assumes solo dev + heavy Cursor assist, 6–8 focused hours/day.

### Day 1 (16 Apr) — Project skeleton

- Init Vite + React + TypeScript.
- Install three, @react-three/fiber, @react-three/drei, zustand, @react-spring/three.
- Minimal scene: a sphere in space, an OrbitControls camera, a directional light.
- Deploy to Vercel. Get the URL live before any real work. This forces an always-deployable state.
- Acquire domain (rubicsworld.xyz or pivot name — see §8).

**Gate:** URL is live and shows a sphere.

### Day 2 — Cubesphere topology

- Generate cubesphere mesh: 6 faces, N=2 per face, 24 tiles. Each tile is a quad projected to sphere surface.
- Each tile has a unique ID and stores (face, slice_x, slice_y, home_face, home_slice_x, home_slice_y, orientation_quaternion).
- Render each tile as a distinct mesh with a solid color per face-of-origin (6 biome colors).
- Verify visually: rotating the planet shows all 24 tiles in expected positions.

**Gate:** you can see a recognizable cubesphere with six colored faces.

### Day 3 — Rotation math

- Implement `rotate(axis, slice_index, direction)` that permutes tile positions and updates orientations.
- Animate the rotation over ~400ms with @react-spring/three.
- Scramble function: 20 random valid rotations from solved state.
- Solve check: compare every tile's current position + orientation against home.

**Gate:** programmatic scramble runs, a programmatic sequence of rotations can solve a scrambled planet, "solved" event fires correctly.

### Day 4 — Ring HUD

- Model the ring: a torus around the planet, subtle metallic shader with an emissive rim.
- Ring rotates to align with one of three axes based on mouse/cursor direction (or keyboard 1/2/3 to switch axis).
- Highlight the active slice on the ring (a glowing band).
- Click-drag on the ring's active slice rotates it; release commits to nearest 90°.

**Gate:** human player can scramble a planet and rotate slices via the ring.

### Day 5 — Puzzle loop complete

- Wire: scramble on load → player rotates → solve check → "settle" event.
- On settle: directional light warms (shift color temperature over 2 seconds), ambient volume swells, ring dims.
- Add a subtle post-processing pass (bloom, vignette) that intensifies post-settle.
- One-tile AI seed: during final third of solve, if player hasn't moved for 8+ seconds, the ring emits a warm pulse and one tile settles autonomously with the low tone.

**Gate:** the full scramble → solve → settle loop works, feels satisfying, and the AI seed fires exactly once.

### Day 6 — Biome art for Meadow planet

- Replace solid-color tiles with low-poly terrain patches: grass, forest, stream, hill, rocky.
- Landmark meshes: a small stone cottage (split across 3 tiles pre-solve), a large tree (trunk + canopy on different tiles), a winding stream (fractured).
- Simple low-poly style. Blender models, Draco-compressed glTF. Keep polycount under 5k triangles total.

**Gate:** the planet looks like a real place you might want to visit, even in its scrambled state.

### Day 7 — Player character and walk mode

- Simple low-poly character (a small figure; face-less, warm-colored).
- Kinematic movement: WASD or arrow keys, gravity-aligned to planet surface (camera-space forward projected onto tangent plane).
- Camera: third-person, orbits character, lerps to follow.
- Walk-view activates automatically after settle event. Puzzle-view deactivates.

**Gate:** post-solve, the player can walk around the planet's surface without falling off or clipping.

### Day 8 — Flag planting

- Press F to plant a flag at current position.
- Flag model: simple pole + colored triangle. Persists via zustand.
- Visible flags in the world (instanced mesh for performance).
- Small planting animation.

**Gate:** you can leave flags, they stay.

### Day 9 — Audio pass

- Ambient bed per state: pre-solve (quieter, subtle wind, reedy hum), post-solve (birds, breeze, distant water).
- SFX: tile rotation (stone-on-stone, pitch varies by axis), tile settle (soft click), AI pulse (the low tone), planet settle (warm chord), flag plant (a soft chime).
- No music. Weather IS the music.
- Howler.js for mixing; preload all audio; trigger based on state events.

**Gate:** closing your eyes and listening, you can tell what state the game is in.

### Day 10 — Polish pass #1

- Lighting calibration. The pre-solve / post-solve transition is the money shot; tune it.
- Warm color grading shader: subtle tone map, slight warm LUT.
- Sky: gradient, soft stars visible. Horizon.
- Ring etching: subtle procedural pattern, not explicit.
- Rocket model: simple low-poly, placed on the meadow.

**Gate:** screenshots start looking like the concept art.

### Day 11 — Async flags (stretch, first attempt)

- Supabase setup: project, `flags` table (id, planet_id, position_x, y, z, color, created_at).
- Anonymous insert on flag plant.
- Fetch all flags on load; render instanced.
- If time remains: add `music_residue` table and simple residue playback.

**Gate:** flags from different devices visible on the same planet.

### Day 12 — Polish pass #2

- Camera transitions smoothed.
- Tile rotation animation polish (ease curve, small camera nudge on rotation).
- Planet-settle moment: tune the timing of light warming, audio swell, post-processing intensification.
- Landing page / splash: title card, "click to begin," nothing else. No "loading."
- Meta tags: og:image (the money screenshot), title, description.

**Gate:** the first 60 seconds of player experience is clean, pretty, and self-explanatory.

### Day 13 — Playtesting

- Recruit 3–5 testers. Watch them play. Say nothing. Take notes.
- Fix only what's blocking: confusing inputs, unclear goals, performance issues.
- Do not add features based on feedback. Feature lock is in effect.
- Performance: profile with Chrome DevTools. Target stable 60fps on mid-range laptop.

**Gate:** testers complete the first solve without prompting. At least one says something like "oh, that's nice" at the settle moment.

### Day 14 — Submission assets

- Record a 30–60 second trailer clip. Silent planet → scramble visible → player rotates → solve → settle → walk → flag plant → end on a planted flag with the rocket in the distance.
- Screenshots: 3 hero shots (the pre-solve scramble, the settle moment, the post-solve walk).
- Write the submission copy (see §7).
- Double-check all rules: domain is free, no login, instant load, works on Chrome + Firefox + Safari.
- Re-test the full loop on a cold cache.

**Gate:** submission assets ready, one click away from sending.

### Day 15 — Submit, buffer, and breathe

- Final QA. Play it yourself start-to-finish twice.
- Submit via the Google form.
- Post on Twitter with the trailer, tagging levelsio, s13k\_, cursor_ai.
- Do not push any more code after submission unless it's a crash fix.

---

## 5. Implementation Notes

### Cubesphere math (reference)

```ts
// Each face has N×N tiles; N=2 for phase 1
const N = 2

type TileID = number
interface Tile {
  id: TileID
  face: 0 | 1 | 2 | 3 | 4 | 5      // +X, -X, +Y, -Y, +Z, -Z
  u: number                          // 0..N-1 within face
  v: number                          // 0..N-1 within face
  homeFace: 0 | 1 | 2 | 3 | 4 | 5
  homeU: number
  homeV: number
  orientation: THREE.Quaternion
}

// For a rotation around axis A by 90° (+ or -):
//   all tiles whose current position lies on the affected slice
//   get their (face, u, v) permuted according to the standard cube rotation
//   and their orientation multiplied by the corresponding quaternion.

// The slice set is a function of (axis, slice_index):
//   - For axis=X, slice_index=0: tiles on face -X + tiles on faces +Y/-Y/+Z/-Z that
//     lie on the u=0 column of those faces.
//   - Standard Rubik's cube literature has these tables worked out; port them.
```

Cursor can one-shot most of this. Spend the effort on the Unity-test: scramble N times, apply the inverse N times, confirm solved state matches initial solved state.

### The ring's input model

The ring is visually a torus around the planet. Interactively:

- Mouse position → compute which third of the screen (left/center/right) the cursor is in → maps to which axis the ring aligns with.
- Scroll wheel → cycle slice within the current axis.
- Click-drag horizontally on the planet → rotate the active slice. Release within 45° of a 90° step commits; otherwise snaps back.

Simple, discoverable, fast-to-implement. No instruction needed because the ring visibly responds to cursor movement from the first frame.

### The AI seed

```ts
// In the puzzle update loop:
const idleTime = performance.now() - lastPlayerMoveTime
const solveProgress = countSolvedTiles() / totalTiles
const shouldSeed =
  !aiSeedFired &&
  solveProgress > 0.66 &&
  idleTime > 8000

if (shouldSeed) {
  const tile = pickMostAlmostSolvedTile()
  triggerRingPulseTo(tile)
  await delay(700)  // let pulse reach tile
  settleTile(tile)
  playLowTone()
  aiSeedFired = true
}
```

One seed per playthrough. Never repeats. The player may not consciously notice; the point is it's there.

### Performance guidelines

- Instanced meshes for grass, rocks, small decoration.
- GLTF models with Draco compression.
- Baked AO into vertex colors where possible (no runtime AO).
- Single directional light + one ambient light. No dynamic shadows at launch; add only if frame budget permits.
- Post-processing: bloom + color grade only. Avoid expensive passes.
- Profile on a mid-range laptop (integrated graphics). Target 60fps; accept 45fps minimum.

### Deployment

```bash
# Vite + Vercel setup
npm create vite@latest rubics-world -- --template react-ts
cd rubics-world
npm install three @react-three/fiber @react-three/drei @react-spring/three zustand howler leva
npm install -D @types/three @types/howler

# Visual editor: install Triplex as a dev tool
npm install -D @triplex/run

# Add a script to package.json:
#   "scripts": { ..., "editor": "triplex editor" }
# Run `npm run editor` in a separate terminal during development.

# Vercel connect
npx vercel link
# auto-deploys on git push to main
```

Triplex runs alongside your Vite dev server. Open your scene file in Triplex, manipulate objects in the 3D viewport, and the changes are written back to the same source files. Leva is added inline in components during tuning sessions and removed when values are frozen.

Domain: buy rubicsworld.xyz (~$3 first year) on Namecheap. Point DNS to Vercel. Done.

---

## 6. Visual and Audio Targets

### The one screenshot that has to land

Hero image: the meadow planet, half-scrambled, ring around it, warm afternoon light, small rocket on a hillside, a few flags planted by players visible on the horizon. Low-poly, warm, inviting.

This shot needs to work as a tweet, a Steam capsule, and a jam gallery thumbnail.

### Color and lighting reference

- **Pre-solve:** slightly cooler, overcast, quieter. The world is "waiting."
- **Post-solve:** warm directional light (2800K ish), soft shadows, fuller ambient, slight bloom. The world is "home."

### Audio reference

- Think: Sable's silence. Journey's wind. A Short Hike's simplicity.
- No musical track until the player plays the flute (if it ships). Weather is the soundtrack.

---

## 7. Submission Strategy

### Title

Working title for the jam: **Rubic's World**. Check trademark friction before launch (see §8). If it becomes a problem, alternatives (pick one fast, domain availability decides):

- **The Last Solver**
- **After the Scramble**
- **Settle**
- **Drop** (as in "the ocean in a drop")

My pick for the jam: **Rubic's World** is fine for the jam submission — it's a small deliverable, Spin Master won't C&D a 15-day jam entry. Rename later if commercialized.

### Tagline

"Solve the world. Then be in it."

### Submission description (for the form)

> Rubic's World is a small planet you arrive on, scrambled. You turn the ring around it until the pieces fit. Then the world settles, the light changes, and you can walk on what you just repaired. There are no points, no timers, no enemies. You can plant a flag. The rocket on the hill is a promise.
>
> Built in 15 days with Cursor Composer 3 and Claude. React + Three.js + R3F. Runs instantly on any browser.

### Tweet (on submission)

> 15 days. One planet. A ring to turn. After you solve it, the light changes and you can just walk around.
>
> Rubic's World — my entry for @levelsio's #vibejam. Built with @cursor_ai Composer 3.
>
> [link]
> [trailer gif]

### What NOT to put in the submission

- The full thesis. Don't spoil it. Keep the jam entry as a playable experience, not a philosophy paper.
- Any promise of the five planets. This is a one-planet entry. Make that entry feel complete.
- Anything about AI-as-liberator beyond what the ring's single pulse already says. Let the judges feel the shape of more without being told.

---

## 8. Decisions to Make Before Day 1 Ends

1. **Domain name.** Buy tonight. My recommendation: `rubicsworld.xyz` if available. Fallback: `rubicsworld.game` (pricier) or one of the alternative titles above.
2. **Repo location.** GitHub repo named `rubicsworld`. Public or private is fine; Vercel reads either.
3. **Twitter post timing.** Post an "I'm building for #vibejam" tweet today with a screenshot of the deployed empty scene. Builds a small narrative for the jury.
4. **Scope lock.** Sign off on the must-ship list in §3. Anything not on that list cannot be added during the 15 days.
5. **No new features after Day 12.** Feature freeze before playtesting. Non-negotiable.

---

## 9. Risks and Mitigations

| Risk | Probability | Mitigation |
|---|---|---|
| Cubesphere rotation math has a subtle bug that desyncs | High | Unit tests on day 3: scramble N, inverse N, assert solved |
| Load time creeps over 3s | Medium | Bundle budget tracking every day; Draco + code-split aggressively |
| The settle moment feels flat | High | Budget 2 full days (day 5 + day 10) to tune lighting, audio, and timing of this single moment |
| Walk mode physics feels floaty or glitchy | Medium | Kinematic-only, no rigid bodies; align to sphere normal with lerp, not instant snap |
| Supabase integration eats a day | Medium | Keep it strong-stretch; cut to localStorage if day 11 goes over budget |
| Domain trademark issue mid-jam | Low | Unlikely in 15 days; rename-later if commercialized |
| AI seed feels gimmicky or invisible | Medium | Tune pulse + tone + timing on day 10; consider a slightly longer pulse if testers miss it |
| Playtesters don't get the "just be here" moment | Medium | The walk mode has to feel good; that's the MVP's entire argument in 15 days |
| Performance on integrated graphics | Medium | Profile on day 13; if needed, lower polycount, cut bloom |
| Burnout before day 15 | High | Hard stop at 8 hours/day. Day 11 is a half-day. Sleep is a feature |

---

## 10. How This MVP Still Carries the Thesis

The full thesis — scramble → solve → AI liberation → post-problem being → sharing — cannot ship in 15 days. But the MVP carries the thesis *in seed form,* and a thoughtful player (or juror) will feel the shape of what it could become:

1. **The scramble/solve/settle loop** is the thesis at the smallest scale: a problem existed, you resolved it, something new becomes available. Not a score. A world.
2. **The walk mode** is the "just be" half. No objective, no score, nothing to do that matters in the utility frame. If the testing shows players meander and feel something, the thesis has landed.
3. **The one AI seed** plants the arc. A juror who plays twice and notices the ring did something on its own will wonder. That wondering is where the full game lives.
4. **The rocket visible but not flying** is the promise of "more planets, more of this, eventually automated." A single visual can carry this whole idea without any text.
5. **Flag planting with async persistence** (if it ships) delivers the sharing half in miniature. You leave something. Someone else will see it. No score, no conversation, just presence across time.

The MVP is not a scaled-down version of the final game. It is the **first beat of the full game, delivered whole.** A tiny complete thing that hints at a bigger complete thing.

That is what the jam rewards. That is what we're building.

---

## 11. Day 1 Checklist

Before ending today:

- [ ] Domain purchased
- [ ] Repo initialized, pushed to GitHub
- [ ] Vercel project linked, first deploy live (even if it's just a spinning cube)
- [ ] `package.json` has three, @react-three/fiber, @react-three/drei installed and importing cleanly
- [ ] "I'm in" tweet posted (optional but recommended)
- [ ] This document re-read, scope locked, going to sleep before 1am

Tomorrow: cubesphere math.

The rest of the game follows from the 15 days being defended. Defend them.
