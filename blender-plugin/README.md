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

Fires on **Export Diorama** and **Validate Scene**. Checks:

| Level | Rule | Why |
|---|---|---|
| ERROR | mesh world-AABB must fit inside one face-block | seam-straddling breaks the fold: what looks adjacent in flat space may meet a non-adjacent face on the cube |
| WARNING | `y_min < 0` | the sphere shader projects sub-zero y into the planet interior — usually a modelling accident |
| WARNING | flat span > 1 unit with fewer than 8 verts per unit along that axis | vyapti PV1: long low-poly meshes chord through the sphere and render invisible |

Errors abort the export. Warnings are printed but the export proceeds.

## Face-block table

Matches `src/diorama/buildDiorama.ts` 1:1 — changing either side means
changing both.

| Name | Cube face | X range | Z range |
|---|---|---|---|
| E | +Z | [−2, 0] | [−1, 1] |
| A | +X | [ 0, 2] | [−1, 1] |
| B | −X | [−4, −2] | [−1, 1] |
| F | −Z | [ 2, 4] | [−1, 1] |
| C | +Y | [−2, 0] | [ 1, 3] |
| D | −Y | [−2, 0] | [−3, −1] |

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
