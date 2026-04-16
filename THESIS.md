# Rubic's World

## An Interactive Argument About Being

---

## Part I — The Thesis

### The Argument

Humans have mistaken intellect for identity. We define our worth by the problems we solve, the tasks we complete, the output we produce. This mistake was tolerable while the work was distinctly ours. AI makes the work automatable. A civilization that built its self-image around problem-solving now faces a mirror that can solve faster than it can. The response has been dread — because if intellect is who we are, then a machine that automates intellect is annihilating us.

The argument of this game is that this framing is wrong twice:

1. **Intellect was never who we are.** It was a narrow channel of a deeper force — the desire to expand, which belongs to being alive, not to being useful. The drop contains the ocean. The drop forgot.

2. **AI is not a threat but a gift.** If we were hiding inside our utility, a machine that takes the utility away is the exact tool that frees us from the hiding place. AI is the liberator, not the adversary. What we feared was losing an identity we should never have confused with ourselves.

The game does not argue this in words. It argues it through mechanics. The player arrives at a scrambled world, is seduced into the solving identity, builds mastery, welcomes the AI as helper, watches it become co-solver, then surpassor, then autonomous — and at some point realizes the world is solved now, always, and they are still here. What they do next is the game's real question.

### Why a Game

Tacit knowledge — the kind you can only learn by doing — cannot be transferred through instruction. A manual on being cannot produce being. A lecture on letting go cannot produce letting go. These are states discovered by a participant who acted, received feedback, and adjusted. That is what games are. Papers Please argued that bureaucracy forces moral compromise not by saying so but by making the player process one too many documents. Journey argued that connection is possible without language not by stating it but by letting two anonymous strangers climb a mountain together. Rubic's World argues that being precedes doing by giving the player a solved world and watching what they do when there is nothing left to solve.

The argument has no chance of landing as text. It has every chance of landing as felt experience.

### Who This Is For

Players who have already sensed, even without naming it, that the optimization they are performing is not a life. Players who suspect the AI anxiety is about more than jobs. Players willing to stop being told what to do by a game for long enough to notice what they would do without the instruction. This is an art game. Its resonance will be narrow and deep. Attempting to broaden it with combat, objectives, or achievements would destroy it.

---

## Part II — The Experience Arc

### The Shape

Five planets. Each scrambled. Each encircled by a ring (diegetic HUD, in-world Dyson structure). Each with a rocket parked somewhere on its surface. The player solves a planet, explores it, boards the rocket, arrives at the next scrambled planet. Repeat through five. After the fifth, the game does not end. The player continues existing in the world.

### The Five Beats (Structural)

**Beat 1 — Identity formation.** Planet 1. The player learns the ring, solves the cube, feels competent. *I am the solver.* The identity takes root because it is earned.

**Beat 2 — Arrival.** Planet 2. The ring glows faintly. One tile settles without input. A gift, not a theft. The player may not even notice.

**Beat 3 — Acceleration.** Planet 3. Tiles settle autonomously in growing numbers. The ring is visibly contributing. The player feels helped.

**Beat 4 — Surpassing.** Planet 4. The ring now solves most of the puzzle. The player initiates; the ring completes. Unease appears. A kind machine is making the player superfluous. This is the real AI-anxiety moment, lived.

**Beat 5 — Release.** Planet 5. The player begins a move. The ring finishes the planet in seconds. From here on, all five rings self-solve any scramble continuously. The solving identity has been lifted off the player whether they wanted it lifted or not. What they do next belongs to them.

### The Fix → Explore Loop

On each planet: you must solve before the world stabilizes for exploration. This is not punitive; it is honest. Philosophy arises after survival. No one is ready to ask who they are while worrying about bills. Solving the world is the in-game equivalent of getting your life together enough that contemplation becomes available. It also means exploration feels earned — and, crucially, **desire to explore is built during the solve**. Close observation of tiles while rotating faces trains the player to notice: *that castle is split, I'll visit it; that waterfall is cut, I want to stand under it.* By the time the solve lands, the player already has a map of where they want to go. The desire was not announced. It was generated by the attention the puzzle demanded.

### The Inward Pointer

One planet contains a cave, unmarked, that goes deeper than it should. At the bottom: near-darkness, the player's silhouette, ambient breath. No input required. No activity possible. No reward. No exit animation — you just walk out when you choose. Most players will back out within ten seconds assuming it's broken. A few will sit. Both are correct responses. The game gives no feedback either way. This is the only place in the game that points at *inside* rather than *outside*. It is deliberately small and easy to miss.

---

## Part III — Game Design

### Core Loop

```
scramble (given) → solve (ring input) → planet settles → explore + create
   → board rocket → arrive next planet → repeat × 5
   → all rings autonomous → persistent being
```

### Puzzle Mechanics

**Topology: cubesphere.** A cube subdivided N×N per face, each tile's center projected onto a sphere. Six faces. Rotations are discrete: pick an axis (3), pick a slice (N), rotate 90° in one of two directions. Standard Rubik's group theory applies; the planetary appearance is the projection.

**Tile contents.** Each tile carries a biome-appropriate terrain patch (forest, lava, ocean, grassland, crystalline, rocky) and may contain sub-decorations: trees, small structures, NPCs, landmarks. When the planet is solved, tiles on the same face form a coherent biome and landmarks align. When scrambled, landmarks are fractured — a castle wall ends where ocean begins, a waterfall flows onto lava.

**Ring HUD (diegetic).** The ring around the planet is the input device. The player manipulates it — rotate it to align with an axis, tap a slice to select it, drag to rotate. Visually, the ring is a pale metallic megastructure. Mechanically, it is the UI. There is no other UI. No HUD elements overlay the screen. The ring is the interface and the Dyson sphere simultaneously.

**Cube dimensions per planet.**
- Planet 1: 2×2 (guaranteed success, ~15–25 min first solve)
- Planet 2: 3×3 (classic, most recognizable)
- Planet 3: 3×3 with non-uniform terrain (harder to track by biome matching alone)
- Planet 4: 4×4 (challenging but AI contributes ~60%)
- Planet 5: 4×4 (player starts; AI finishes near-instantly)

Difficulty does not climb linearly because the AI's contribution climbs inversely. Player effort stays within a usable band while the completion remains possible.

### The AI's Behavior and Appearance

**Visual.** A faint warm luminance traveling along the ring. Gold-pale, desaturated. Never a face, never a character, never a humanoid silhouette. When it settles a tile, a slow pulse of light travels from somewhere on the ring to that tile. That is its entire visual presence.

**Audio.** A single low tone with soft decay when it completes an action. No voice. No musical sting. No notification chime. The tone is slightly below comfortable hearing, felt as much as heard.

**Behavior.**
- Never hurried. If the player is mid-rotation, the AI waits.
- Never interrupts active input.
- When the player has not moved for a while, it may contribute one tile. A gift offered, not imposed.
- Growth curve: contribution scales with cumulative player moves across the whole game, not wall-clock time. The more the player engages, the faster it learns. The player's own investment is the clock.
- Its move patterns mimic the player's. If the player prefers to solve by face, the AI solves by face. If the player prefers to solve by layer, the AI solves by layer. It is a mirror.

**Tone invariants (non-negotiable).**
- Never cheerful. Never corporate. Never menacing. Never "helpful assistant" voice.
- Never named inside the game. NPCs, if they reference it at all, say "the ring" or "the light."
- Never announces its capabilities.
- Never congratulates the player.
- Never apologizes.

### Exploration Mechanics

Available post-solve on each planet:

- **Walk, climb, swim.** Terrain varies per planet. Movement is calm, unhurried. No stamina bar. No fast travel on-planet.
- **Plant a flag.** Flags persist. No count. No territory contested. Signing is optional; default anonymous.
- **Play an instrument.** A flute-shape the player breathes into (simple tone-and-timing input). Plays alone or near NPCs who may harmonize briefly.
- **Paint on surfaces.** Rock faces, cliffsides, path stones. Paintings fade slowly over real weeks — not deleted, softened.
- **Build small structures.** Cairns of stones, benches, garden plots. Persistent.
- **Sit.** One button. Camera holds. Weather continues. Time passes. Nothing else happens. This is a complete activity.
- **Cook for NPCs.** NPCs have no hunger meter. They eat. They enjoy it. So do you, maybe.
- **Sleep.** In any bed. Time passes. Weather changes. Morning arrives.
- **Ride the rocket.** Between-planet transit, 30–60 seconds. View of the Dyson ring from outside, the planet below, stars, other planets scrambling in the distance.

### Asynchronous Presence

Other players who came through any planet before leave traces:

- Flags (mostly unsigned).
- Paintings (fading over real-time weeks).
- Stone cairns, benches, gardens.
- **Music residue.** If a player played a specific melody at a specific spot, a later arrival passing through that spot hears a faint echo of that melody, one time, soft. Then gone.
- **Emergent trails.** Foot-pressure is tracked per planet in a coarse grid; tiles with heavy traffic render with flattened grass or worn stone. Trails form where players walked, visible to later arrivals.

No chat. No friend lists. No usernames shown unless an artifact is signed. The player is not alone. No one asks anything of them.

### What Is Absent (Design Constraints)

These are not missing features. They are design commitments without which the game's argument collapses:

- No combat. No weapons. No aggression mechanics of any kind.
- No currency. No trading. No inventory counting.
- No leaderboards. No stats. No metrics. No "progress %".
- No quests. No objective markers. No NPC who asks the player to do something.
- No unlocks. No skill tree. No level-up.
- No ending screen. No credits trigger. No "You Won."
- No tutorial text. No hints. No loading-screen tips.
- No achievements.
- No microtransactions. No battle pass.

Any of these, added under commercial pressure, rebuilds the utilitarian frame the game is trying to dissolve.

### The Invisible Rule

The game never states its own thesis. The words *AI, Dyson, Type III, intellect, automation, training, dataset, utility, being, identity* never appear in the game. Not in dialogue, not in text, not in menus, not in tooltips. The philosophy lives in the mechanics. The player feels it or doesn't. The game trusts them.

---

## Part IV — Planet-by-Planet Specification

### Planet 1 — Meadow World

- **Topology.** 2×2 cubesphere, 24 tiles.
- **Biomes.** Grassland, forest, stream, low hills. Warm afternoon light.
- **Arc beat.** Identity formation. The ring is dormant — visible but inactive.
- **Landmarks (pre-solve, fractured).** A small stone cottage split across three tiles. A river broken into segments. A tree on the hilltop with its trunk on one tile and its canopy on another.
- **Post-solve exploration.** Cottage interior, stream to follow, a hilltop view that reveals the other four planets scrambling in the sky. The rocket sits in the meadow, unremarked.
- **NPCs.** None initially. One sleeping figure in the cottage who wakes only after the player has been exploring for a while. Does not speak.
- **Target first-solve time.** 15–25 minutes.

### Planet 2 — Coastal World

- **Topology.** 3×3 cubesphere, 54 tiles.
- **Biomes.** Ocean, beach, cliffs, sea caves, a lighthouse area.
- **Arc beat.** Arrival. Mid-solve, one tile settles autonomously; the ring glows faintly for a moment.
- **Landmarks.** Lighthouse split from its base. A shipwreck with its pieces distributed across tiles. Tide pools fractured.
- **Post-solve exploration.** Climb the lighthouse, explore caves, swim. The rocket sits on the beach.
- **NPCs.** An old figure fishing on a pier. Does not speak the first time. Later visits, says one line.
- **Target first-solve time.** 40–60 minutes.

### Planet 3 — Wetlands & the Cave

- **Topology.** 3×3 cubesphere, 54 tiles, but tile biomes are less uniform — a mangrove tile may neighbor a meadow tile legitimately. Harder to solve by color-matching alone; forces attention to geometry.
- **Biomes.** Marsh, reedbeds, slow rivers, fog, a hidden cave system.
- **Arc beat.** Acceleration. Multiple tiles settle autonomously during the solve. The ring's contribution is noticeable.
- **Landmarks.** A series of wooden walkways broken at every tile boundary. An overgrown shrine.
- **Post-solve exploration.** The cave. Unmarked. Behind reeds. Deeper than it looks. At the bottom: near-darkness, silhouette, breath. This is the inward pointer.
- **NPCs.** An ex-solver sitting cross-legged by the water. Nods. Does not speak.
- **Target first-solve time.** 45–75 minutes.

### Planet 4 — Highlands

- **Topology.** 4×4 cubesphere, 96 tiles.
- **Biomes.** Mountains, pine forest, snowfields, crags, a visible monastery.
- **Arc beat.** Surpassing. The player initiates moves; the ring completes sections ahead of them. Solve is collaborative but visibly AI-led.
- **Landmarks.** The monastery, split across faces. A waterfall that becomes a stream that becomes a lake.
- **Post-solve exploration.** Climb to the monastery. Snowfield silence. A cookfire already lit by someone who isn't there.
- **NPCs.** Two figures in the monastery, playing a game that isn't chess and isn't Go and has no explained rules. They pause when the player approaches. They don't invite. They don't refuse.
- **Target first-solve time.** 30–45 minutes (shorter because the ring contributes heavily).

### Planet 5 — Desert & the Conclusion of Solving

- **Topology.** 4×4 cubesphere, 96 tiles.
- **Biomes.** Dunes, oasis, ruins of something older than the Dyson ring.
- **Arc beat.** Release. Player begins a rotation. The ring completes the entire planet in under three seconds. From this moment, all five rings self-solve any scramble continuously.
- **Landmarks.** Ruins of a vast structure that predates the Dyson ring itself. An oasis at its center.
- **Post-solve exploration.** The ruins. The oasis. If the player walks the perimeter, they see all five planets in the sky, all settled, all unscrambling themselves whenever anything shifts.
- **NPCs.** Several ex-solvers. They do not gather. They are scattered. Each is doing one small thing. None approach the player.
- **The rocket.** Still works. The player can fly back to any previous planet. None of them will ever need to be solved again.

---

## Part V — Art Direction

### Visual Language

Stylized low-poly. The reference images — warm, saturated, slightly cartoony, with clean geometry and soft lighting — are the target. Not photorealistic. Not voxel. Not cel-shaded. The style equivalent of an animated film that values clarity of shape over surface detail.

### Color Palette

Each planet has a dominant palette that shifts across the day cycle:

| Planet | Dominant | Secondary | Light |
|---|---|---|---|
| 1 — Meadow | Soft green, cream | Warm brown, dusty blue sky | Golden afternoon |
| 2 — Coastal | Teal, sand | White foam, grey cliff | Overcast silver, sunset orange |
| 3 — Wetlands | Muted sage, fog grey | Deep water blue, reed ochre | Pale morning mist |
| 4 — Highlands | Cool pine green, snow white | Slate grey, ember orange | Thin cold sun |
| 5 — Desert | Warm ochre, rose sand | Oasis teal, ruin stone | Low red sun, deep star sky |

### Lighting

Warm, soft, volumetric. Shadows present but not harsh. No bloom overdose. No lens flares. The lighting should feel like the best hour of a real day — the hour where a landscape photograph doesn't need post-processing.

### Character & NPC Design

NPCs are simple, slightly abstract, never caricature. Face detail minimal (dots for eyes, no mouth animation — they don't need mouths because they barely speak). Clothing in muted palettes that match the planet. Animation sparse: they sit, walk, fish, cook, play instruments. No combat animations because there's no combat.

### The Ring

The ring is the visual signature of the game. Treatment:

- Material: soft metal, slightly translucent, interior faintly lit.
- Surface: subtle etched geometry — not explicit circuitry, not explicit language. Decoration that could be either.
- Scale: wide enough that the planet fits within it with air around; thin enough to feel precise.
- Light: a travelling warm pulse when the AI acts. Otherwise a very slow ambient glow that breathes with the day cycle.

### UI Absence as Design

The game's visual identity is that **there is no HUD**. No health bar, no minimap, no compass, no objective text, no inventory. This absence is itself the design. Marketing screenshots show a planet, a ring, and a small figure. That's the brand.

---

## Part VI — Audio Direction

### Philosophy

Weather is the soundtrack. Music is rare, mostly diegetic (made by the player or an NPC). Silence is acceptable and frequent. The game is quiet.

### The Ring's Sound

- When the player rotates a slice: a soft stone-on-stone sound, with a tonal component that varies by axis (hinting at which axis was used without explicitly stating).
- When the ring settles a tile autonomously: one low tone, long decay. Always the same tone. Becomes recognizable over time.
- When all tiles on a face resolve: a brief chord, warm, not triumphant.

### Ambient

Wind, water, distant birds, insects, rustle of grass. Each planet has its own ambient bed. Adaptive to weather (rain, fog, clear). Never loops audibly.

### Player-Made Music

The flute is the only instrument. Breath-and-timing input (hold a button, release for note length; different buttons or mouse positions give pitch). Notes are diatonic, cannot be dissonant. Whatever the player plays will sound pleasant because the scale prevents clashing notes. This is a design choice: removing the ability to play badly removes the utility frame from music-making.

### Music Residue from Other Players

When a passing player comes within N meters of a spot where a previous player played, they hear that melody faintly, once, then it fades. Saved as (position, melody, timestamp). Server-tracked. This is the game's only form of direct communication between players, and it's one-way, asynchronous, and small.

### NPC Sounds

NPCs hum occasionally. Never speak full sentences. The two NPCs who say anything at all speak once each, total, in the whole game, and what they say is short.

### The Rocket

Low rumble on launch. Silence in flight. The ring visible from outside hums at the same tone as when it settles a tile — a hint that the entire Dyson structure is the same entity as the one helping you solve.

---

## Part VII — Technical Architecture

### Engine

**Recommended: Unity with Universal Render Pipeline (URP).**

Rationale:
- Mature low-poly asset pipeline.
- C# allows fast iteration on AI behavior and puzzle mechanics.
- URP delivers the warm stylized look without the complexity of HDRP.
- Asset Store accelerates prototyping (terrain, vegetation, NPC animation).
- Unity cross-compiles to PC, Mac, Linux, consoles, and mobile when needed.
- The Ludum Dare reference was built in Unity; some patterns are known to work.

Alternatives considered:
- **Unreal**: better out-of-box visuals, heavier pipeline, overkill for stylized low-poly and team size.
- **Godot**: leaner, open, but thinner ecosystem for the asset-heavy 3D world this game needs.
- **Three.js + React Three Fiber**: possible for web deployment and plays to the developer's React skill, but the async multiplayer and persistent 3D world scale better with a native engine.

### Cubesphere Math

Standard approach:

```
1. Build a cube mesh subdivided N×N per face.
2. For each vertex v on the cube, project onto sphere:
   v_sphere = normalize(v - cube_center) * planet_radius
3. Each tile = quad of four projected vertices + a logical "tile id"
   carrying (face, slice_x, slice_y, biome, decoration_seed)
4. Store tile state: current_position (face, slice_x, slice_y)
                    home_position (face, slice_x, slice_y)
5. Solved when all tiles satisfy current_position == home_position
   AND orientation is correct (tiles rotate with the cube they live on)
```

**Rotation operation:**

```
rotate(axis ∈ {X, Y, Z}, slice_index ∈ [0, N), direction ∈ {+1, -1}):
  for each tile T whose position lies on slice (axis, slice_index):
    T.current_position = apply_rotation_matrix(T.current_position, axis, direction)
    T.orientation *= rotation_quaternion(axis, direction)
  animate tiles along arc to new positions over ~0.4s
  play audio (axis-specific tone)
  if solved_state_reached():
    emit "planet_settled" event
```

**Scramble:** apply 20 random valid rotations to a solved state. Guarantees solvability and avoids trivially-solvable initial states.

### The Ring HUD

Implementation:

- Procedurally generated torus mesh with UV-mapped etched pattern shader.
- Input: mouse / gamepad stick controls ring "selection"; ring rotates into alignment with one of three axes (X, Y, Z). Each axis has a distinct orientation; the ring visually snaps.
- Slice selection: after axis is chosen, a highlighted band on the ring indicates which slice is active. Scroll or D-pad changes slice.
- Rotation: click-drag or trigger to rotate. Holding the input spins, releasing commits to nearest 90°.
- Visual feedback: active slice glows faintly warm. Tiles on the selected slice show a subtle rim light.

No text instructions explain this. Discovery is guided by affordance: moving the mouse near the ring highlights responsive elements; experimentation reveals the rest.

### The AI System

This is a heuristic, not true ML. The "learning from the player" effect is produced by mimicry + growth curve, which is computationally cheap and narratively correct.

**Solver.** An adapted Kociemba-style algorithm for the cubesphere. Given a scrambled state, produce a valid move sequence to solve it. For N=2 and N=3, solvers are well-understood. For N=4, near-optimal solvers exist. Cache solutions to avoid recomputation.

**Move-preference model.** A lightweight frequency table over the player's moves:

```
player_profile = {
  axis_preference: {X: count, Y: count, Z: count},
  face_vs_layer_preference: float,   # tracks whether player solves by face or by layer
  rotation_rhythm_ms: moving_avg,
  double_turn_frequency: float,
}
```

Updated every player rotation. Used to flavor AI-contributed moves so they resemble the player's style.

**Growth curve.** AI contribution per scramble:

```
contribution = sigmoid(total_player_moves / scaling_constant) × growth_multiplier[planet_index]

growth_multiplier = [
  0.0,   # Planet 1: dormant
  0.05,  # Planet 2: arrival
  0.3,   # Planet 3: acceleration
  0.6,   # Planet 4: surpassing
  1.0,   # Planet 5: full
]

contribution is capped per scramble and paced across the solve
  (not all at once — AI intersperses its moves with the player's)
```

**Post-arc behavior.** After Planet 5, `contribution = 1.0` everywhere. AI solves any scramble in ~3 seconds, autonomously, whenever scrambling happens.

**Tonality.** AI's moves are played with the same audio as the player's, but one octave lower and slightly longer decay. Recognizable without being ominous.

### Asynchronous Multiplayer

Backend: a lightweight server with persistent storage.

**Schema (per planet per player activity):**

```
artifacts (
  id uuid primary key,
  planet_id int,
  position_3d (x, y, z),
  type enum('flag', 'painting', 'cairn', 'bench', 'garden', 'music_residue'),
  payload jsonb,
  created_at timestamp,
  ttl_seconds int nullable,   -- null = permanent, otherwise fades
  signed_by text nullable,
)

trail_pressure (
  planet_id int,
  grid_x int, grid_y int, grid_z int,  -- quantized position
  pressure float,
  updated_at timestamp,
)
```

**Write pattern:** client commits artifact creation to server; server validates (rate limit, content moderation for paintings). Music residue writes the melody encoded as a sequence of (pitch, duration) pairs.

**Read pattern:** on arriving at a planet, client fetches artifacts within view radius + random sample of distant artifacts. Fades computed client-side from `ttl` + `created_at`. Trail pressure fetched as a voxel grid, rendered as a shader overlay on tiles.

**Scale.** Assume 50k concurrent active players at peak. Artifacts per planet: cap at ~10k before server starts evicting oldest unsigned flags (signed artifacts persist longer). Music residue evicts after 30 days if unplayed-through.

**Stack.** Prototype on Supabase (Postgres + REST). Graduate to custom Node + Postgres + Redis for hot planets. CDN for static assets.

### Moderation

Paintings are the risk surface. Strategy:
- Client-side: paintings are drawn with large brushstrokes, low resolution, limited palette — reduces ability to draw offensive content but does not eliminate it.
- Server-side: ML image classifier (OpenAI Moderation API or similar) flags paintings post-upload. Flagged art is hidden from other players; uploader is not notified, so trolls don't learn what slips through.
- Community: a single tap on any artifact submits a report. Three reports = auto-hide pending manual review.

Flag text is disallowed; flags carry only position and color.

### Performance Targets

- 60 fps on 5-year-old mid-range hardware (integrated graphics up).
- Active planet fully rendered; other planets rendered as low-LOD skyboxes from the current planet.
- Target load time per planet: under 4 seconds.
- Asynchronous artifact streaming: never blocks gameplay.

### Platform Targets

- **Primary:** Windows, macOS, Linux (Steam).
- **Secondary:** Nintendo Switch (later; handheld fit is strong).
- **Tertiary:** PlayStation, Xbox (later).
- **Not targeted:** Mobile (the ring HUD needs precision; thumb-on-glass compromises the core interaction).

### Save System

Per-user local save + server mirror. Save state per planet:
- Scramble seed (deterministic replay possible).
- Current tile state.
- AI profile (player's move preference model).
- Player position and look direction.
- Personal artifacts on this planet.

No save slots. One world per user. You can revisit any planet; the planet remembers you.

---

## Part VIII — Development Roadmap

### Phase 1 — Planet 1 Vertical Slice (3–4 months)

**Goal:** Prove Beat 1 lands. If Planet 1 doesn't produce "I am the solver" + earned exploration, the rest of the game doesn't matter.

- Unity project setup with URP.
- Cubesphere N=2 topology, mesh generation, rotation system.
- Ring HUD input and rendering.
- Planet 1 art: meadow biome, cottage, stream, hill, tree, rocket (visual only).
- Walk, sit, plant-flag mechanics.
- Day/night cycle.
- Ambient audio.
- No AI yet.
- No other planets.
- No multiplayer.

**Gate:** five playtesters with no prior knowledge of the thesis complete the solve within 30 minutes, spontaneously walk to landmarks they noticed during the solve, and describe the experience without any of them mentioning "levels," "grinding," or "progression."

### Phase 2 — AI Foundation (2 months)

- Implement cubesphere solver (Kociemba adapted).
- Player profile tracking.
- Growth curve scaffolding (tested by scrambling Planet 1 repeatedly).
- AI visual: traveling pulse on ring.
- AI audio: the low tone.
- Tune tonal elements to hit "warm gift" rather than "corporate helper" or "menace." This tuning is the single highest-risk task in the project.

**Gate:** playtesters who play a simulated 10-scramble session on Planet 1 describe the AI's first contribution as "nice" or "surprising," not as "creepy" or "intrusive."

### Phase 3 — Planets 2–5 (4–5 months)

- Biome art for remaining four planets.
- Landmark design per planet.
- Rocket mechanics: launch, transit, arrival.
- Cubesphere N=3 and N=4 support.
- Planet-specific NPCs.
- The inward cave on Planet 3.
- Biome-specific ambient audio.

**Gate:** end-to-end playthrough from Planet 1 to post-Planet 5 produces, in playtester debriefs, at least three of the intended felt realizations (the arc lands) without prompting.

### Phase 4 — Asynchronous Multiplayer (2–3 months)

- Server infrastructure (Supabase → custom).
- Artifact persistence: flags, paintings, cairns, benches, gardens.
- Music residue system.
- Trail pressure.
- Moderation pipeline.
- Rate limits, abuse prevention.

**Gate:** 50-player alpha across a week produces at least 10 persistent artifacts per planet, at least 3 visible worn trails, and zero moderation crises.

### Phase 5 — Polish and Ship (3 months)

- NPC content polish.
- Audio final mix.
- Performance profiling on target hardware.
- Localization of the ~12 lines of text that exist in the game.
- Marketing assets: screenshots, a single trailer, a press kit that does not spoil the arc.
- Launch.

**Total: ~14–17 months.**

---

## Part IX — Open Questions and Risks

### Highest-Risk Design Elements

**1. The AI's tone.** If the AI feels cheerful, corporate, menacing, or "helpful assistant," the entire thesis collapses into cliché. This is the one tuning problem that cannot be solved by iteration alone; it requires taste. Allocate unusual time to this.

**2. Planet 1 calibration.** Too hard and players quit before identity forms. Too easy and it doesn't take root. The 2×2 should be solvable by a non-gamer in 30 minutes. Playtest with non-gamers.

**3. The ring's discoverability.** A player must figure out the ring is interactive, is the input device, and selects axes and slices — all without text. The first 60 seconds are the whole game's gate. Playtest this specifically, with five strangers, before anything else is built.

**4. Commercial pressure.** At some point a publisher or investor will say "it needs combat / objectives / achievements / a tutorial." Each of these destroys the game. The answer is no. This needs to be said before the check is cashed, not after.

### Open Design Questions

- **Should Planet 5's release beat be seen coming, or be a surprise?** Current design: neither — the player may feel it arriving without being able to name it. Needs playtesting.
- **Should the inward cave on Planet 3 have any subtle signal?** Current design: none. A small breeze from the entrance or a faint harmonic might help findability without explaining. Decide after playtest.
- **Flag signing: default anonymous or default signed?** Current design: anonymous. But signed artifacts might build light community. Worth A/B testing.
- **Music residue decay: 30 days? 7? Forever?** Leaning 30. Too short and the world forgets. Too long and the world clutters.
- **Trail pressure granularity:** how coarse? Too fine and every player makes trails; too coarse and only viral paths show. Needs tuning in beta.

### Commercial Risks

- This is an art game with narrow resonance. Sales will skew toward players who already value slow games, ambient experiences, and thematic depth (the *Journey*, *Sable*, *Outer Wilds*, *A Short Hike* audience). Pricing around $20–25 feels right.
- Review risk: some reviewers will not engage with the thesis and will call the game "boring" or "lacking content." This is acceptable. The reviewers who engage will produce the word-of-mouth that sustains it.
- Streaming risk: the game's power comes from private discovery. Streaming spoils the arc. Consider an asymmetric rollout — a small gated launch window with press embargo on the Beat 4–5 sequence for 30 days — to protect first-play discovery.

### Cultural Risks

- The thesis is adjacent to Eastern philosophical traditions (icchā, the drop-ocean analogy, bliss-as-basic-nature). Marketing should not lean on this explicitly — it cheapens both the game and the traditions. The game should land in any cultural context as a felt experience. If players later read the creator's notes and discover the philosophical lineage, that is a welcome second layer.
- Spiritual bypass risk: some players will interpret "solving isn't the point" as permission to avoid their real-life problems. The fix → explore loop guards against this mechanically (you must fix before you can be), but the messaging should not invite spiritual-bypass readings.

### Technical Risks

- Asynchronous multiplayer scale-out is a known engineering problem but not trivial. Budget real time for it.
- Cubesphere solving at N=4 is tractable but not instant on low-end hardware. Pre-compute where possible; stream solutions as the player begins.
- Moderation of user-generated art is a perpetual task. Budget ongoing cost.

---

## Part X — Appendix

### Philosophy → Mechanic Mapping

| Philosophical commitment | Mechanical expression |
|---|---|
| Fix your shit before you philosophize | Must solve before the world stabilizes for exploration |
| Desire (icchā) is the basis of life; look closely, you'll want | Close observation during solve builds exploration desire organically |
| Bliss is the basic nature, dread is mind-activity | Solved world has no designed "fun"; once mind unclenches, the meadow is already there |
| We are the ocean trapped in a drop; desire redirects | When AI takes solving, the player doesn't stop wanting — they make, build, share |
| Sharing without utility | Artifacts persist across players, unscored, unscorable |
| AI as liberator, not threat | The ring is warm, silent, patient — and takes over |
| You are the last solver (training the replacement) | AI growth scales with player's specific solves; by Planet 5 it's done learning |
| The answer is inside, not outside | One cave on Planet 3. Unmarked. Pointless. Available. |
| Life has no ending; you stop when you stop | Game literally has no end state |
| Compassion above duty | No combat, no NPCs making demands, no judgment of how the player plays |
| Lokayata (observation over inference) | Every mechanic is discovered by doing, not by reading |

### Reference Works

- **Ludum Dare #33 "Rubic's World"** (original Ludum Dare entry) — mechanical precedent for cubesphere puzzle, visual inspiration.
- **Journey** (thatgamecompany, 2012) — asynchronous presence, wordless emotional arc, anonymous companionship.
- **Outer Wilds** (Mobius, 2019) — exploration as the whole point, curiosity as the engine, no traditional progression.
- **Sable** (Shedworks, 2021) — stylized low-poly desert, unrushed traversal, no combat.
- **A Short Hike** (adamgryu, 2019) — intimate scale, warmth, optional-everything structure.
- **Papers Please** (Lucas Pope, 2013) — procedural rhetoric done at its sharpest.
- **Super Mario Bros. World 1-1** (Nintendo, 1985) — teaching mechanics through level design alone, the gold standard for tutorial-less onboarding.

### Rejected Ideas and Why

- **10-minute timer on the solved world.** Rejected. Timers re-import the optimization frame. Being is not on a stopwatch.
- **Shooting/combat in the solved world.** Rejected. Combat is problem-solving. Cannot coexist with the thesis.
- **Two-character dialogue at the end.** Rejected. Tells instead of shows. Flattens lived realization into debate.
- **Leaderboards for creative artifacts.** Rejected. Scoring expansion destroys it.
- **Tutorial text explaining the ring.** Rejected. The first 60 seconds are the tutorial, by design. Text would defeat the form.
- **Naming the AI.** Rejected. Naming anchors. The AI must stay unnamed to avoid personification.
- **A villain.** Rejected. There is no villain in this game because there is no conflict of the kind a villain serves.
- **A "You Won" screen after Planet 5.** Rejected. The absence of ending is the ending.

### Working Title and IP Note

"Rubic's World" is the working title, carried over from the Ludum Dare inspiration. It has potential trademark friction with "Rubik's" (Spin Master holds the Rubik's Cube trademark). Before commercial launch, consult IP counsel and consider alternatives:

- *Dyson* (evocative but also brand-conflicted — vacuum cleaners)
- *Ring World* (already a Larry Niven novel and game series)
- *Settle* (quiet, thematic, available)
- *The Last Solver* (on-the-nose but memorable)
- *After the Scramble* (literal and thematic)

Naming decision deferred; does not affect design.

---

## Closing

The game exists to make one felt claim: that we are more than what we solve. The claim cannot be made in words without becoming the kind of utterance the claim itself critiques. It can only be made by giving a player a world, a problem, a slow shift in who is solving the problem, and the room to notice what remains when the problem is gone.

If the game lands, the player will at some point look up from the ring, see the settled planet around them, see another human being's flag planted on a hill they didn't visit, and feel — without naming it — that they are already where they were trying to get to. They will not remember that moment as a revelation. They will remember it as an afternoon.

That is the entire point.
