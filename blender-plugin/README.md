# Rubic's World — Blender addon (v0.2.0 / "plugin v2")

Round-trip the diorama.glb between Blender and the live app. One panel in
the N-sidebar, one preference (project path), three main buttons.

**v2 adds KHR_audio_emitter export** — author Speaker objects in Blender,
they ship in the .glb as positional audio emitters with per-emitter
gain / refDistance / maxDistance / rolloff. See `Audio (KHR_audio_emitter)`
section below.

**v2 also makes animation export WYSIWYG** — drivers and constraints get
sampled to keyframes on export, Speaker.volume keyframes round-trip as
baked envelopes, and clips honor a `_once` naming convention for
play-once-and-hold semantics. See `Animations` section below.

## Animations (WYSIWYG)

What you see playing in Blender is what plays in the runtime.

**What round-trips automatically:**
- Object TRS keyframes — translate / rotate / scale across the timeline
- Armature pose actions
- Shape keys / morph targets
- **Drivers** (Python-expression-driven values like `#frame * 0.1`)
- **Constraints** (Track To, Follow Path, Copy Rotation, etc.)
- **Procedural animation** sourced from constraints + drivers

The export does this via `export_force_sampling=True` — every frame in the
scene range is sampled and written as an explicit keyframe. Without this,
drivers and constraints would silently flatten on the runtime side
(glTF can't represent expressions, only keyframes).

**Naming convention for clip behaviour:**
- Action ending in `_once` or `_oneshot` (e.g. `intro_once`) → plays once
  and clamps to the last frame in the runtime. Use for one-shot beats
  (intros, scripted reveals, single-fire animations).
- Anything else → loops infinitely. Default for ambient cycle anims
  (windmill spin, car drive cycle, bird flapping).

**Speaker.volume keyframes** — animate a Speaker's `Volume` property in
Blender (right-click the field → Insert Keyframe), and the addon samples
the curve across the scene frame range and bakes it into the emitter's
`extras.rubics.envelope`. The runtime multiplies envelope[time] into the
loop's gain on every tick, so authored volume curves replay verbatim.

**The "Bake Animations" button** flattens all drivers and constraints on
selected objects (or all objects) into explicit keyframes BEFORE export.
You don't normally need this — `export_force_sampling=True` handles it
during export — but use it when you want to:
- Inspect the baked output in Blender (see the keyframes appear in the
  graph editor)
- Hand a "clean" .blend to another author with no driver setup
- Lock down scripted motion that you don't want re-evaluated at export
  time

**What does NOT round-trip:**
- Geometry node animations beyond what `export_apply` can flatten
- Particle systems (use simulated/baked alembic + import)
- Shader / material animations (project uses its own sphere-projection
  shader anyway — author lighting via PBR property values, not Cycles
  node trees)

## Audio (KHR_audio_emitter)

Author sound emitters using Blender's native **Speaker** object
(Object → Add → Speaker). Properties map to KHR_audio_emitter on export.

**Workflow:**

1. **Add a Speaker.** Object → Add → Speaker. Drag it where the sound
   should originate, or **parent it to an animated object** (the windmill,
   the car) — animation propagates via standard scene-graph parenting.
2. **Set the sound file.** In the Speaker's data properties (the speaker
   icon), set `Sound` to a file inside `<project>/public/audio/` (e.g.
   `windy_grass.ogg`). The exporter writes the basename and prefixes with
   `audio/` automatically.
3. **Set the falloff.** Speaker properties:
   - `Distance > Reference` → `refDistance` (full-volume inner radius)
   - `Distance > Maximum`   → `maxDistance` (silence beyond this)
   - `Attenuation`          → rolloff factor (1.0 = standard linear)
   - `Volume`               → emitter gain (clamped 0..1)
4. **Optional: project-private modulator metadata** (custom properties
   on the Speaker object — Object Properties → Custom Properties):
   - `rubics_audio_key` (string) — override the loop key
   - `rubics_audio_params` (string, JSON) — full LoopDef.params shape
     (e.g. `{"vol":{"base":0.5,"modulator":"windStrength"}}`)
   - `rubics_audio_modulator` (string) — modulator name(s),
     comma-separated for a list
   - `rubics_audio_vol` (float) — base volume override
5. **Export.** Standard Export Diorama / Live Mode does it. The exporter
   walks Speakers, post-patches the .glb with `KHR_audio_emitter` data.
6. **Mute a Speaker** → it's skipped from export (Blender's Mute toggle
   on the Speaker datablock).

Animations on the parent flow through automatically (the speaker rides
the parent's TRS). Animated `speaker.volume` keyframes are NOT
round-tripped in this version — modulators (project's runtime gain
sources) are the recommended path for dynamic gain.

The runtime is sphere-projection aware: emitters anchored anywhere inside
the cube-net are projected onto the visible sphere position before audio
distance is computed (so "inside the zone" matches what the user sees).

## Install

1. **Zip the addon** (or point Blender at the single file):
   ```sh
   (cd blender-plugin && zip -r /tmp/rubics-world-blender.zip rubics_world.py)
   ```
2. **Blender → Edit → Preferences → Add-ons → Install…**  
   Pick `/tmp/rubics-world-blender.zip`, tick the checkbox next to
   "Import-Export: Rubic's World".
3. **Set Project Path** inside the addon preferences — point it at the
   RubicsWorld repo root (the folder that contains `public/`).
4. Close preferences. In the 3D Viewport, open the sidebar (`N` key) →
   "Rubic's World" tab.

## Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│ Project                                                             │
│   <path to RubicsWorld>                                             │
│   public/diorama.glb                                                │
├─────────────────────────────────────────────────────────────────────┤
│ [ Import Diorama ]   loads public/diorama.glb into a fresh scene    │
│ [ Export Diorama ]   validate + write back to public/diorama.glb    │
│ [ Validate Scene ]   pre-flight checks (no export)                  │
├─────────────────────────────────────────────────────────────────────┤
│ Live mode:    [ ON / OFF ]                                          │
│   last export: 2s ago  ✓                                            │
│   http://localhost:5174/?glb=1                                      │
├─────────────────────────────────────────────────────────────────────┤
│ Reference guides:                                                   │
│ [ Add Face-Block Guides ]     6 labelled wireframe cages @ Z∈[0,1]  │
│ [ Remove Guides ]                                                   │
├─────────────────────────────────────────────────────────────────────┤
│ Dev server:                                                         │
│   cd <project> && npm run dev                                       │
│   → http://localhost:5174/?glb=1                                    │
└─────────────────────────────────────────────────────────────────────┘
```

## Live mode

Toggle the **Live Mode** button in the panel. While it's ON, the addon:

1. Registers a `depsgraph_update_post` handler that flags the scene "dirty"
   whenever anything changes.
2. Polls every 1.5 s via `bpy.app.timers`. If the dirty flag is set AND
   you're in Object mode (no mid-edit state), it runs the same glTF export
   as the **Export Diorama** button and clears the flag.
3. Vite's dev server is already watching `public/`, so as soon as the new
   `.glb` lands it hot-reloads the page.

**View the live diorama at → http://localhost:5174/?glb=1**

Notes:
- Edit-mode changes don't export until you leave edit-mode (safer than
  exporting mid-triangulation).
- Debounce is 1.5 s — rapid-fire edits collapse into one export per tick.
- The panel shows `last export: Ns ago ✓` so you know the round-trip is
  working.
- Turn OFF when you're done iterating — the handler adds some per-update
  overhead.

1. **Start the dev server** in the project: `npm run dev`.
2. **Import Diorama** — or use the included sample from `make-sample.py`
   as a starting point.
3. **Add Face-Block Guides** once — shows the 6 × 2×2 blocks your content
   must sit inside, each labelled with its cube-face normal (`E +Z`,
   `A +X`, `B −X`, `F −Z`, `C +Y`, `D −Y`).
4. Model / animate. Keep every object **strictly inside one face-block**
   (the validator enforces this).
5. **Export Diorama** → writes `public/diorama.glb`. Vite's HMR reloads
   the browser; visit `http://localhost:5174/?glb=1` to see your scene
   on the planet.

## Pre-flight validator

Fires on **Export Diorama** and **Validate Scene**. Coordinates are Blender
native (Z up, XY ground). The validator is intentionally permissive — the
sphere-projection pipeline stitches cross-row geometry seamlessly via
per-tile clip planes + shared cube edges, so row containment is NOT a
real constraint. What actually breaks the render:

| Level | Rule | Why |
|---|---|---|
| ERROR | mesh AABB is **entirely outside** the `x∈[-4,4], y∈[-3,3]` domain | nothing renders meshes outside the cross cube-net — likely a stray / lost object |
| WARNING | ground-plane span > 1 unit with fewer than 8 verts per unit along that axis | vyapti PV1 — long low-poly meshes chord between sparse verts and cut through the sphere surface, rendering invisible or at the wrong elevation. This is why the road is subdivided. |
| WARNING | `z_min < −0.10` (below 10 cm modelling-noise threshold) | sub-terrain geometry gets buried in the planet interior |

Errors abort the export. Warnings are printed but the export proceeds.
Objects named `terrain` / `sphere-terrain` / `ground` are skipped (they're
supposed to span everything).

## Face-block table (Blender Z-up)

Labelled reference for each 2×2 block inside the rows above. Guides use
these:

| Name | Cube face | X range | Y range |
|---|---|---|---|
| E | +Z (front) | [−2, 0] | [−1, 1] |
| A | +X (right) | [ 0, 2] | [−1, 1] |
| B | −X (left) | [−4, −2] | [−1, 1] |
| F | −Z (back) | [ 2, 4] | [−1, 1] |
| C | +Y (top) | [−2, 0] | [ 1, 3] |
| D | −Y (bottom) | [−2, 0] | [−3, −1] |

The glTF export uses `+Y Up`, so on the three-js side Blender Y becomes
three's Z — the app's `buildDiorama.ts` table uses that three-js frame.
Same cross shape, axes renamed.

## Animations

All F-curve / armature / shape-key animations export automatically
(`export_animations=True`). The app's `AnimationMixer` plays every clip
on loop. Don't keyframe the root-level transform of any object — the
app's tile rotation writes there every frame and would fight your
keyframes.

## Not in this version

- Dev-server HTTP sync (no manual file step)
- "New Project" template with face-block guides pre-placed
- Batch versioning / snapshot history
- Convention-aware naming helpers (preserving `pond` / `road` / etc. for
  meadow AABB exclusion is currently on you)
