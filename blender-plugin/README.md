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
│ Reference guides:                                                   │
│ [ Add Face-Block Guides ]     6 labelled wireframe rects at y=0     │
│ [ Remove Guides ]                                                   │
├─────────────────────────────────────────────────────────────────────┤
│ Live preview:                                                       │
│   npm run dev → http://localhost:5174/?glb=1                        │
└─────────────────────────────────────────────────────────────────────┘
```

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
native (Z up, XY ground). Checks:

| Level | Rule | Why |
|---|---|---|
| ERROR | mesh world-AABB must fit inside one **unfold row** | rows don't share cube edges — a mesh crossing from the middle row into the top or bottom row folds into a non-adjacent face |
| WARNING | `z_min < 0` | sub-terrain geometry gets spherified into the planet interior (usually a modelling accident) |
| WARNING | ground-plane span > 1 unit with fewer than 8 verts per unit along that axis | vyapti PV1 — long low-poly meshes chord through the sphere and render invisible. This is why the road is subdivided. |

Errors abort the export. Warnings are printed but the export proceeds.

**Unfold rows** — an object must fit inside ONE of these (spanning X within the middle row is fine, e.g. the road):

| Row | X range | Y range |
|---|---|---|
| middle (B, E, A, F) | [−4, 4] | [−1, 1] |
| top (C) | [−2, 0] | [ 1, 3] |
| bottom (D) | [−2, 0] | [−3, −1] |

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
