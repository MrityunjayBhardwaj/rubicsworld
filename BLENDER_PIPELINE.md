# Blender → Rubic's Sphere Pipeline

End-to-end workflow for authoring a diorama in Blender and shipping it as the
puzzle planet in Rubic's World.

---

## 1. Mental model — two rendering layers

The sphere planet is composed of **two independent layers**, and they have
different authoring stories. Get this right before opening Blender.

| Layer | What it is | Authored where | Follows tile rotation? |
|---|---|---|---|
| **Global terrain** | One continuous `SphereGeometry` with triplanar-projected texture. The visible green base. | **Code** — `buildSphereTerrain()` in `src/diorama/buildDiorama.ts`. Texture: drop a tileable image in `public/textures/`. | Yes — but per-fragment, via shader uniforms. No mesh authoring needed. |
| **Per-tile objects** | Trees, huts, windmills, ponds, anything that sits *on* the planet. Rendered 24× per frame, once per tile, with cube-cell clip planes. | **Blender** → glTF → `public/diorama.glb` | Yes — the tile they spawn in carries them through every rotation. |

Why this matters: you do **not** author terrain in Blender. The grass under
the puzzle is a sphere with a tileable texture; that's a code/asset concern,
not a Blender concern. Blender is for the *world that lives on top of* the
terrain.

---

## 2. Cross cube-net layout

Per-tile content is authored on a flat **cross cube-net** that folds onto the
6 cube faces. The cross has **24 filled cells** (4 per face) inside an **8×6
bounding box**, centered at world origin.

```
Z+
↑
│              ┌─────┬─────┐
│              │ C00 │ C01 │   row 5    (C = +Y face / top)
│              ├─────┼─────┤
│              │ C10 │ C11 │   row 4
│              ├─────┼─────┤
│              │ E00 │ E01 │   row 3    (E = +Z face / front)
│              ├─────┼─────┤
│              │ E10 │ E11 │   row 2
│  ┌─────┬────┼─────┼─────┼─────┬─────┬─────┬─────┐
│  │ B00 │B01 │ A00 │ A01 │ F00 │ F01 │  …  │     │
│  ├─────┼────┼─────┼─────┼─────┼─────┤  unfilled │
│  │ B10 │B11 │ A10 │ A11 │ F10 │ F11 │   cells   │
│  └─────┴────┼─────┼─────┼─────┴─────┴───────────┘
│              │ D00 │ D01 │   row 1    (D = −Y face / bottom)
│              ├─────┼─────┤
│              │ D10 │ D11 │   row 0
│              └─────┴─────┘
└────────────────────────────────────→ X+
```

**Face-block table** (each block is 2×2 world units, 4 cells):

| Face | Cube normal | World X | World Z | Notes |
|---|---|---|---|---|
| **E** | +Z (front) | `[-2, 0]` | `[-1, 1]` | The center block — visible by default |
| **A** | +X (right) | `[ 0, 2]` | `[-1, 1]` | Right of E in the cross |
| **B** | −X (left)  | `[-4,-2]` | `[-1, 1]` | Left of E in the cross |
| **F** | −Z (back)  | `[ 2, 4]` | `[-1, 1]` | Right of A — unfolds opposite to E |
| **C** | +Y (top)   | `[-2, 0]` | `[ 1, 3]` | Above E — unfolds onto top |
| **D** | −Y (bottom)| `[-2, 0]` | `[-3,-1]` | Below E — unfolds onto bottom |

**Coordinate convention:**
- Y is **up** (perpendicular to ground). Objects sit on Y=0 with positive
  extents upward. Blender exports +Z-up by default; the glTF exporter's
  `+Y Up` setting (default on) handles the conversion automatically.
- One Blender unit = one world unit = one tile.
- Cells outside the cross (the empty padding) are **not rendered** on the
  sphere. Anything you put there in Blender is wasted polygon budget.

---

## 3. Authoring rules

### Placement
1. **Each object must sit inside one face-block.** Objects that straddle
   internal block edges (e.g. `(x=0, z=0)` on the E↔A border) fold onto the
   cube edge between those faces, which is fine because the cross-net layout
   guarantees flat-adjacent = cube-adjacent.
2. **Don't straddle the cross arms.** Objects placed across the gap between
   B and the C/D stems (e.g. spanning x=−2 to x=−2.5 at z=2) fall in
   non-rendered padding and disappear.
3. **Y=0 is ground.** Buildings/trees grow upward. Negative Y goes
   underground (into the sphere) and gets clipped.
4. **Stay within the height budget.** The sphere projection bezier maps
   `Y ∈ [0, ~1]` to a curved height above the surface; very tall objects
   (Y > 1) compress visually. Default scale: huts are ~0.4 tall, trees ~0.5.

### Polygon budget
- **Whole diorama under ~5,000 triangles.** Mobile-first. Use chunky low-poly,
  not subdivided meshes.
- One material per mesh where possible — saves draw calls.

### Materials
Use **Principled BSDF only**. The glTF exporter maps it to
`MeshStandardMaterial` in three.js. Properties that survive the export:

| Blender property | Three.js property | Notes |
|---|---|---|
| Base Color (RGB) | `material.color` | sRGB. Grass-y greens read well. |
| Roughness | `material.roughness` | Use `0.7–0.95` for natural surfaces, `0.05–0.15` for water/glass |
| Metallic | `material.metalness` | `0` for everything except actual metal. Stone, wood, leaves = 0. |
| Base Color **texture** | `material.map` | Embed in the .glb (Pack Resources). Keep under 1024² unless you really need detail. |
| Normal Map | `material.normalMap` | Optional. Adds surface detail without geometry. |

**Don't use**: subsurface, sheen, clearcoat, transmission, screen-space
effects (SSR, SSAO). They either don't survive the glTF round-trip or
require shader patches on our end.

**Pack textures inside the .glb** — File → External Data → Pack All Into
Blend, then export with Materials = Export. Keeps deployment to a single
file.

---

## 4. Naming conventions for animation hooks

The engine looks up specific names via `scene.getObjectByName()` to drive
per-frame animations. Match these and animation comes for free; ignore them
and the object renders static.

| Object name pattern | Animation applied |
|---|---|
| `windmill_blades` | Spins on local Z at `0.8 rad/s` |
| `tree_sway_<n>` | Tilts gently on Z+X axes via `sin(t*1.2 + phase)` |
| `smoke_<n>` | Scrolls up + fades, scaled per-particle |
| `pond` | Vertex-displaced ripple shader |
| `stream` | Same as pond, smaller radius |
| (anything else) | Renders static |

You can have **multiple** of the suffixed ones (`tree_sway_1`, `tree_sway_2`,
…) — the engine iterates them.

For one-off animations, prefer this convention over Blender NLA tracks. NLA
keyframes work but cost more bytes and don't compress under Draco.

---

## 5. Export settings

`File → Export → glTF 2.0 (.glb/.gltf)`

| Setting | Value | Why |
|---|---|---|
| **Format** | `glTF Binary (.glb)` | Single file, embedded textures |
| **Include** | `Selected Objects` | Leave camera/lights/helpers out |
| **Transform** | `+Y Up` ✓ | Three.js convention — keep this on |
| **Geometry → Apply Modifiers** | ✓ | Bakes Subsurf/Mirror/etc. |
| **Geometry → UVs** | ✓ | Required for any textured material |
| **Geometry → Normals** | ✓ | Required for PBR shading |
| **Geometry → Vertex Colors** | ✓ if used | We use them only on the (hidden) flat terrain — fine to leave on |
| **Materials → Materials** | `Export` | All Principled BSDF settings |
| **Materials → Images** | `Automatic` (embed) | Keeps it one file |
| **Compression → Draco** | ✓, quality `6` | 5–10× smaller, no visible loss |
| **Animation** | only if you used NLA tracks | Off otherwise — saves bytes |

Output → `public/diorama.glb` (Vite serves it at `/diorama.glb`).

---

## 6. Engine integration

Currently `src/diorama/buildDiorama.ts` builds the diorama imperatively in
JavaScript. To consume a Blender .glb instead, replace the body of
`buildDiorama()` with a glTF loader call. Sketch:

```ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'

const draco = new DRACOLoader()
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
const gltfLoader = new GLTFLoader()
gltfLoader.setDRACOLoader(draco)

let _cached: DioramaScene | null = null

export async function loadDiorama(url = '/diorama.glb'): Promise<DioramaScene> {
  if (_cached) return _cached
  const gltf = await gltfLoader.loadAsync(url)
  const root = gltf.scene
  root.name = 'diorama'

  // Sphere projection moves vertices in the vertex shader; bounding spheres
  // computed by three.js in object space don't reflect that — culling kicks
  // wrongly. Disable for everything in the diorama.
  root.traverse(o => { o.frustumCulled = false })

  // Wire named animation hooks (replaces the per-builder updates today).
  const blades = root.getObjectByName('windmill_blades')
  const trees: THREE.Object3D[] = []
  root.traverse(o => { if (o.name.startsWith('tree_sway_')) trees.push(o) })
  // …same for smoke_*, pond, stream…

  // PBR/IBL/Fresnel — picks up every MeshStandardMaterial automatically
  applyFresnelPatchToScene(root)

  const update = (t: number) => {
    if (blades) blades.rotation.z = t * 0.8
    trees.forEach((g, i) => { g.rotation.z = Math.sin(t * 1.2 + i * 2.1) * 0.03 })
    // pond?.update(t); stream?.update(t)
  }

  _cached = { root, update }
  return _cached
}
```

The existing per-tile clipping, sphere projection, slice-rotation tracking,
and seamless terrain all keep working unchanged — they operate on whatever
mesh tree `buildDiorama` returns.

The `BuildDioramaOpts.includeTerrain` flag still applies: in sphere mode,
the global terrain renders separately, so even if your .glb contains a
ground plane it'll be ignored in sphere view. Keep ground out of Blender.

For ergonomics, mirror the HDRI panel pattern: an "Upload diorama.glb"
button that takes a `File`, creates a blob URL, and re-runs `loadDiorama`.
Falls back to the procedural builder when nothing is loaded.

---

## 7. Validation pass

After exporting, check the diorama in this order:

1. **Cube net (`/` `View: Cube net`)** — confirms layout. Every authored
   object should sit inside its face-block. Anything in the padding area is
   wasted.
2. **Cube (`View: Cube`)** — confirms the fold. Objects on the cross seams
   should bend cleanly across the cube edge between adjacent faces. If
   something looks "torn", it's straddling a non-adjacent seam (rare given
   the cross layout, but possible if you placed something across the wrong
   cells).
3. **Sphere (`View: Sphere (planet)`)** — final look. Objects ride on the
   green sphere terrain. Seams between faces should be invisible (terrain
   is one continuous mesh).
4. **Scramble + Solve cycle** — every object should travel rigidly with its
   tile. No popping, no sliding-against-terrain (the texture should stay
   "painted on" each tile through rotations).

Fast iteration loop:

```
Blender:  edit → Export glTF (Ctrl+E from your last export reuses settings)
Browser:  Ctrl+R   (or use the Upload button — no rebuild)
Eyeball:  cube net → cube → sphere
```

---

## 8. Customizing the global terrain

Independent from Blender. Two knobs:

### Texture
Drop a tileable color JPG/PNG at `public/textures/<name>.jpg` and update the
URL in `grassTexture()` in `buildDiorama.ts`:

```ts
function grassTexture(): THREE.Texture {
  if (_grassTex) return _grassTex
  const tex = new THREE.TextureLoader().load('/textures/your_terrain.jpg')
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  _grassTex = tex
  return tex
}
```

The texture is sampled via **triplanar mapping** (no UVs needed, no pole
pinching). For finer detail, bump `uTriplanarScale` in
`patchMaterialForTriplanar` — `0.5` = one repeat per cube face, `1.0` =
four repeats per face.

### Geometry
Edit `buildSphereTerrain()` to swap `SphereGeometry` for displaced terrain,
icospheres, or a custom mesh. The triplanar shader and per-tile-orientation
tracking work on any mesh whose extent stays within the unit cube (~radius
1) — `computeTileIdx` uses world-position-to-cube-cell classification and
assumes that scale.

If you want hills/mountains: add a vertex shader displacement that pushes
sphere normal outward. Don't replace the geometry with one that breaks the
unit-cube assumption (e.g. radius 5) without also updating `computeTileIdx`.

---

## 9. Architectural guarantees (so you know what won't break)

- **Adding new MSM-materialed meshes inside the diorama** → automatically
  gets the Fresnel toggle, IBL knobs, sphere projection, per-tile clipping,
  and rotation following. No code changes.
- **Replacing the entire diorama .glb** → no code changes once the
  `loadDiorama()` path is wired in.
- **Changing the terrain texture** → swap the file, change one URL.
- **Changing terrain geometry** → swap one function body, mind the unit-cube
  scale.

What does require code changes:
- Adding a **non-rotating** decoration (clouds, atmosphere, stars). Don't
  put it in the diorama .glb — add it directly to the main R3F scene in
  `App.tsx`.
- Adding a **second textured global layer** (oceans on top of land) — needs
  another `patchMaterialForTriplanar` call and an extra render pass.
- Changing rubik dimensions (3×3 instead of 2×2) — touches `TILE_COUNT`,
  the `uTileOriInv[24]` array size, and the index formula in two places.
- Materials that aren't `MeshStandardMaterial` (Basic, Lambert, custom
  ShaderMaterial) won't get the Fresnel/IBL plumbing. Stick to
  Principled BSDF in Blender to stay on the happy path.

---

## 10. Day-to-day loop

```
┌───────────────────────────────────────────────────────────────────────┐
│  Blender                                                              │
│    1. Edit mesh inside face-block extents (see §2)                    │
│    2. Use Principled BSDF, name animation-hookable objects (§4)       │
│    3. File → Export → glTF Binary → public/diorama.glb (§5)           │
│                                                                       │
│  Browser                                                              │
│    4. Ctrl+R (or click "Upload diorama.glb" if you've wired the UI)   │
│    5. Validate: net → cube → sphere → scramble + solve (§7)           │
│                                                                       │
│  Tune live (no re-export)                                             │
│    6. HDRI preset / exposure / Fresnel / roughness boost              │
│    7. Triplanar density (`uTriplanarScale`)                           │
└───────────────────────────────────────────────────────────────────────┘
```
