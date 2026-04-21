# Rubic's World — Blender addon

Round-trip the diorama.glb between Blender and the live app. One panel in
the N-sidebar, one preference (project path), three main buttons.

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
