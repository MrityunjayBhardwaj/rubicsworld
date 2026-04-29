# Vyāpti Catalogue — RubicsWorld

> Project-specific structural regularities (invariants). Each entry documents
> a regularity that has been validated by direct observation, where it holds,
> where it breaks, and how it was confirmed.
>
> Vyāptis are the structural spine of understanding. They're not facts about
> specific code — they're patterns that hold across cases. When a new situation
> matches a known vyāpti, the solution is often immediate.
>
> This catalogue grows across sessions. Load at session start.
>
> **Maintenance:** At every 10th entry, review all entries. Remove any that
> are contradicted by newer entries, too specific to one instance (not
> generalizable), or describe patterns the codebase no longer has.
> When a vyāpti's scope conditions change, update the entry — don't add a new one.
>
> **Quality-filtered growth (sādhanā):** Only add invariants that were
> confirmed by direct observation (Lokāyata-verified), not by inference
> alone. An invariant that "should hold" but was never directly tested
> is a hypothesis, not a vyāpti. The catalogue contains only what has
> been seen, not what has been reasoned about.

## Entry Format

```
### [ID]: [Name]

**Statement:** Wherever [A], necessarily [B].

**Causal status:**
- CAUSAL: Intervening on A directly changes B
- STRUCTURAL: A and B are connected by system architecture
- EMPIRICAL: A and B co-occur reliably but mechanism is complex

**Scope:** Where this holds.
**Breaks when:** Where this doesn't hold (scope conditions).
**Confirmed by:** [Direct observation that validated this — date]
**Implication:** [What this means for design/debugging decisions]
```

## Universal Vyāptis (Software Engineering)

### UV1: Container Ownership
**Statement:** Wherever a visual element is placed inside a container, the container owns the element's available dimensions.
**Causal status:** STRUCTURAL — layout architecture dictates this.
**Scope:** CSS layout, component trees, view containers, any parent-child rendering.
**Breaks when:** The child has fixed/absolute positioning that takes it out of flow; the child is in an off-DOM fragment where parent dimensions read as 0.
**Implication:** Never hardcode sizes in child components. Always read from parent or accept as props/parameters.

### UV2: Framework Prototype Sovereignty
**Statement:** Wherever a framework initializes by writing to prototypes, it will overwrite any pre-installed methods on those prototypes.
**Causal status:** CAUSAL — plain assignment overwrites previous value.
**Scope:** Any framework that uses `X.prototype.method = fn` during initialization.
**Breaks when:** The framework uses `defineProperty` with `configurable: false` (rare).
**Implication:** Install interceptors AFTER framework initialization, or inside an initialization hook that fires at the right moment.

### UV3: Pipeline Argument Transformation
**Statement:** Wherever a build pipeline or framework processes method calls on domain objects, it may transform arguments before the method handler receives them.
**Causal status:** CAUSAL — the pipeline rewrites calls or wraps arguments.
**Scope:** Transpilers, macro systems, decorator/middleware pipelines, any compile-to-runtime chain.
**Breaks when:** The method is called from non-pipeline code (direct calls, tests, REPL).
**Implication:** Always test through the real pipeline, not just direct calls. Handle both raw and transformed argument types.

### UV4: Async Construction
**Statement:** Wherever a constructor defers setup to a callback (animation frame, timeout, microtask), post-constructor calls may execute before setup completes.
**Causal status:** CAUSAL — event loop ordering.
**Scope:** Any framework with deferred initialization — UI libraries, game engines, media APIs.
**Breaks when:** Construction is fully synchronous.
**Implication:** Wrap post-setup operations inside the setup callback itself, or use a completion signal (callback, promise, event).

### UV5: Method Chain Identity
**Statement:** Wherever a method on a domain object returns a new instance (not the original), properties set on the pre-call object are NOT present on the post-call object.
**Causal status:** STRUCTURAL — different object references.
**Scope:** Immutable/functional APIs, fluent APIs that create new instances, any builder pattern that clones.
**Breaks when:** The method explicitly returns the same object (mutable builder pattern).
**Implication:** When intercepting methods that may return new instances, tag the RETURN VALUE, not the original object.

### UV6: Observation Without Mutation
**Statement:** Wherever you modify system state to observe it, you change the behavior you're trying to observe.
**Causal status:** CAUSAL — intervention changes the system.
**Scope:** Any system where observation requires tapping into data flow — audio routing, message queues, network streams.
**Breaks when:** The observation tap is truly passive (read-only tap, side-connection that doesn't redirect).
**Implication:** Design observation as passive side-taps, never as re-routing or reassignment.

## Project-Specific Vyāptis

_(Add entries below as they're validated during this project.)_
_(Each entry must include a `**REF:**` field pointing to a Ground Truth doc.)_

### PV1: Vertex-Shader Projection Needs Vertex Density
**Statement:** Wherever a vertex shader displaces geometry along a non-linear surface (sphere projection, terrain displacement, bezier curves), the mesh must have enough vertex density along the spanned axis that adjacent vertices after displacement stay close to the target surface. Linear triangle interpolation between sparse vertices cuts chords through the target surface.
**Causal status:** STRUCTURAL — rasterization interpolates linearly between vertex outputs; curvature between vertices exists only if vertices sample it.
**Scope:** Any mesh in diorama-root that gets patched with `patchMaterialForSphere` — particularly long boxes, planes, or primitives spanning multiple cube face blocks.
**Breaks when:** Geometry is small enough that flat interpolation is indistinguishable from the curve (e.g., a 0.15×0.035 dash over the same span is approximately flat).
**Confirmed by:** 2026-04-19 — road strip invisible in sphere mode with `BoxGeometry(8, 0.025, 0.32)`; became visible at `BoxGeometry(8, 0.025, 0.32, 64, 1, 1)`. Color-to-red diagnostic confirmed zero red pixels before fix, clearly visible red strip after.
**Implication:** For any long/wide mesh added to the diorama: segment count along the spanning axis ≥ ~8 per cube-face-block. Applies to future rivers, rail tracks, cable spans, fence runs, etc.
**REF:** UNGROUNDED — projection shader at `src/diorama/TileGrid.tsx:370-413`; canonical instance `src/diorama/buildDiorama.ts:687` (road strip).

### PV2: Scene-Shared State Requires Per-Frame Push
**Statement:** Wherever multiple libraries / components read-write the same `THREE.Scene` top-level properties (`scene.environment`, `scene.environmentIntensity`, `scene.backgroundIntensity`, `scene.backgroundRotation`, etc.), the authoritative push must run every frame, not inside a store-dep `useEffect`.
**Causal status:** STRUCTURAL — React effects are invalidation-driven (re-run only when deps change). Scene-state resets from sibling mount paths are not expressible as dep changes in the consumer's deps array, so the effect never re-fires to reassert the correct value.
**Scope:** Any scene-level uniform or scalar consumed across mount boundaries — drei `<Environment>`, `<OrbitControls makeDefault>`, React-three-fiber's own internals.
**Breaks when:** The property is component-local (a ref on a specific mesh) rather than scene-wide; no other code writes it; or the store-dep effect covers all reset paths (rare — siblings mount non-deterministically with respect to your deps).
**Confirmed by:** 2026-04-22 — HDRI intensity/blur/rotation reverted to three defaults on walk-mode entry despite the store holding the right values; `tests/hdri-persist.mjs` snapshots confirmed scene drift without store change. Fix: moved push to `useFrame` in `HDRIEnvironment`.
**Implication:** For shared scene state, prefer `useFrame` over `useEffect`. Cost is trivial (scalar assignments); robustness gain is total. Add a diagnostic harness that snapshots store + scene to detect divergence when introducing a new shared property.
**REF:** UNGROUNDED — canonical instance `src/world/HDRIEnvironment.tsx:48-62`.

### PV3: Mutable-ref props behind React wrappers need per-frame re-attach
**Statement:** Wherever a library wraps an imperative instance in a `useMemo` keyed on every prop AND exposes a mutable-ref prop (e.g. `target={vec3}`, `depthTexture={tex}`), the ref prop must be re-attached to the live instance on every frame via an identity check — not via `useEffect` keyed on a stable dep list.
**Causal status:** STRUCTURAL — the wrapper's re-memoisation invalidates any external ref connection silently; React doesn't know the ref should re-run its effect.
**Scope:** `@react-three/postprocessing` `DepthOfField`, any similar wrapper pattern where the inner instance gets recreated on prop change. Likely applies to many pmndrs wrappers around postprocessing passes.
**Breaks when:** The wrapper stabilises the inner instance across prop changes (most R3F primitive wrappers do this). Check via `dispose` behaviour in the wrapper source.
**Confirmed by:** 2026-04-21 — DoF cursor-follow worked at mount, silently broke on first Leva slider drag. Probe proved effect re-instantiation; per-frame identity check fixed it permanently.
**Implication:** For ANY R3F/drei/postprocessing wrapper where we need to drive a mutable parameter from our own animation loop, pattern is:
```tsx
useFrame(() => {
  if (!ref.current) return
  if (ref.current.target !== ourVec3) ref.current.target = ourVec3
  // ...mutate ourVec3 here
})
```
**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` (DoF target re-attach).

### PV4: Tone mapping belongs on the renderer, not in the effect chain
**Statement:** Wherever a scene uses postprocessing effect passes (especially realism-effects SSGI/SSR/TRAA, or any effect reading from the input buffer expecting linear color), the tone mapping must be applied by the renderer (`gl.toneMapping = ACESFilmicToneMapping`), NOT via a `<ToneMapping>` effect component.
**Causal status:** CAUSAL — effects read inputBuffer.texture; if tone mapping is upstream in the effect chain, effects read already-compressed non-linear color and produce visually wrong output (SSGI bounce light reads too dim, bloom highlights over-bloom, etc.).
**Scope:** Any scene with effect-based postprocessing that reads scene color.
**Breaks when:** No effects read color (pure overlays like selective bloom, screen-space UI). Then tone mapping location doesn't matter.
**Confirmed by:** 2026-04-20 — Path 1 architecture; SSGI's built-in tonemapping block assumes linear input. Moving ACES to renderer kept the effect chain correct.
**Implication:** Configure ACES tone mapping on the R3F Canvas gl config; don't add a `<ToneMapping>` to PostFx. Compensate with `toneMappingExposure` for HDRI brightness (we run at 1.35).
**REF:** UNGROUNDED — canonical instance `src/App.tsx` (Canvas gl config).

### PV5: Effect chain contract with Canvas config
**Statement:** Wherever an R3F scene uses a pmndrs `<EffectComposer>`, the Canvas + composer config must satisfy:
- `<Canvas gl={{ antialias: false }}>` — SMAA runs in the effect chain instead
- `<EffectComposer multisampling={0}>` — SSGI (Path 2) needs full MSAA control
- `<EffectComposer stencilBuffer depthBuffer>` — standardises depth texture format so downstream passes (DoF, AO) read consistent formats
**Causal status:** STRUCTURAL — each clause is driven by a specific downstream pass requirement.
**Scope:** Any scene preparing for or running SSGI / SSR / TRAA alongside standard effects.
**Breaks when:** Scene uses only screen-space overlays (UI), no depth-dependent effects.
**Confirmed by:** 2026-04-20 — enabling stencilBuffer flipped depth format from DepthFormat+FloatType to DepthStencilFormat+UnsignedInt248Type, which is what most passes expect.
**Implication:** Treat this as the default recipe for any R3F scene with realism-effects-adjacent ambitions. Deviate only with reason.
**REF:** UNGROUNDED — canonical instance `src/App.tsx` (Canvas) + `src/world/PostFx.tsx` (EffectComposer).

### PV6: InstancedMesh + material-level vertex patch must fold `instanceMatrix`
**Statement:** Wherever a material's `onBeforeCompile` replaces `<project_vertex>`, the replacement MUST include `instanceMatrix` in worldPos (under `#ifdef USE_INSTANCING`), else all instances collapse to instance[0]'s location.
**Causal status:** CAUSAL.
**Scope:** `patchMaterialForSphere` + any future vertex-displacement patch used with InstancedMesh.
**Breaks when:** Patch only runs against non-instanced geometry.
**Confirmed by:** 2026-04-21 — grass InstancedMeshes invisible in sphere mode until the guard was added.
**Implication:** Canonical snippet in `src/diorama/TileGrid.tsx:patchMaterialForSphere` — copy when writing new vertex patches.
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `src/diorama/TileGrid.tsx` (project_vertex override with USE_INSTANCING branch).

### PV7: Instance order must be shuffled when `mesh.count` is user-controlled
**Statement:** Wherever the visible count of an InstancedMesh is driven by a user slider, instance matrices must be Fisher-Yates shuffled across authoring groups so `count = N` is a uniformly random subset.
**Causal status:** STRUCTURAL — three renders `instances[0..count)`; unsorted group-order produces group-wise disappearance.
**Scope:** Grass + 4 flower meshes; any future count-controlled instanced population.
**Breaks when:** Count is always 100% OR order is visually meaningful.
**Confirmed by:** 2026-04-21 — density slider at 10% showed grass only on first-sampled face blocks before shuffle.
**Implication:** Shuffle in lockstep with every per-instance attribute (`iHue`).
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `src/diorama/buildGrass.ts` (per-bucket shuffle).

### PV8: Rebuildable scene state lives in module-scope refs, not React state
**Statement:** Wherever user state must survive a scene rebuild triggered outside React (hot reload, rebuildWithMask, mode switch), it lives in a module-scoped mutable ref that the build path reads, plus an explicit post-swap re-apply callback the rebuilder invokes.
**Causal status:** CAUSAL — React doesn't re-fire useEffect on external three.js identity changes.
**Scope:** `grassRefs.activeMask`, `grassRefs.reapplyControls`, every mesh/count slot on grassRefs.
**Breaks when:** State is purely ephemeral (e.g. mouse position).
**Confirmed by:** 2026-04-21 — hot-reload swap dropped painted mask + density back to defaults until mirrored into grassRefs and `reapplyControls()` called post-swap.
**Implication:** When you add a Leva knob affecting a rebuildable object, store in grassRefs AND register in reapplyControls. Don't rely on useEffect deps.
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `src/diorama/buildGrass.ts:grassRefs`.

### PV9: Blender addon authors in Z-up; glTF export_yup=True bridges sides
**Statement:** The Blender addon uses Blender-native Z-up (ground=XY, height=Z). glTF export flips to Y-up at the boundary. `buildDiorama.ts` face-block tables use three-js Y-up; the addon's tables use Blender Z-up.
**Causal status:** STRUCTURAL — two frames bridged by the exporter's Y-Z swap.
**Scope:** Blender addon files + the loadGlbDiorama path.
**Breaks when:** Export flag changed to `export_yup=False` (would require three-js side changes).
**Confirmed by:** 2026-04-21 — first guide-pass drew vertical rects because the validator used three-js axes.
**Implication:** Every axis-aware line in the addon uses Blender conventions. README carries both tables for reference.
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `blender-plugin/rubics_world.py` (FACE_BLOCKS y_min/y_max) vs `src/diorama/buildDiorama.ts` (z_min/z_max header).

### PV10: Scene-graph helpers called post-mount must neutralise the diorama root transform
**Statement:** Wherever a function called on an already-mounted diorama root reads `matrixWorld` (via `setFromObject`, `applyMatrix4`, `updateMatrixWorld` propagation), it must save/zero/restore the root's transform around the work. Initial-mount identity is not a stable invariant — TileGrid mutates `root.position/quaternion/matrix` every frame.
**Causal status:** STRUCTURAL — the 24-pass rendering contract explicitly uses the root matrix as scratch space.
**Scope:** `buildGrass`, `weldCubeNetSeams`, any future diorama-level helper.
**Breaks when:** TileGrid's per-pass transform-write strategy changes to push into a child rather than the root (would invert the contract).
**Confirmed by:** 2026-04-22 — rebuildWithMask returned ~400 candidates in a sliver near one face; fix landed in 9435936.
**Implication:** Every such helper ships a save/restoreRoot pattern — do not assume identity. New helpers must follow suit.
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `src/diorama/buildGrass.ts` (save/restoreRoot block) + `src/diorama/weldSeams.ts` (`try/finally` with prev* snapshots).

### PV11: Grass emitter requires a ground/terrain-named mesh IN THE DIORAMA ROOT; presence ≠ visibility
**Statement:** `buildGrass` sources its candidate sampling region from the first mesh (under the diorama root it was handed) whose name starts with `ground` or `terrain` (case-insensitive, so Blender's `terrain.001` matches). If no such mesh exists → `console.error` + `emptyGrassResult()`. No hardcoded fallback cube-net. **The mesh must be PRESENT in the root, but need not be VISIBLE** — `traverse()` visits invisible meshes (grass can still read geometry for AABB + triangles), while `WebGLRenderer` skips drawing them. Render-optimization toggles belong on `.visible`, never on root membership.
**Causal status:** CAUSAL — the sampler needs an authoritative footprint; silent defaults would hide authoring bugs.
**Scope:** `src/diorama/buildGrass.ts`, both imperative and glb load paths.
**Breaks when:** An optimization path in TileGrid or buildDiorama *removes* the terrain mesh from the root to avoid double-draw (P23 — what happened in sphere mode with a separate global sphere-terrain). A new diorama pipeline that emits procedurally with no ground mesh also violates this; such pipelines need a different emission source.
**Confirmed by:** 2026-04-22 — ground-authored grass shipped in 8d2b9ca. 2026-04-23 — presence-vs-visibility distinction established after sphere-mode regression (c00ef33 + P23).
**Implication:** Every diorama must expose a named ground/terrain in the root passed to `buildGrass`. Blender addon's Init Scene and FACE_BLOCKS guides enforce this by construction. In sphere mode the imperative path keeps its flat `terrain` plane in the root and toggles `visible=false` so the global sphere-terrain is the one that actually renders.
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `src/diorama/buildGrass.ts` (GROUND_NAME_PREFIXES, emptyGrassResult exit paths); `src/diorama/TileGrid.tsx:hideFlatTerrainInSphereMode`.

### PV12: Grass blades MUST adhere to the ground's sculpted surface (height + normal)
**Statement:** Every blade's position is lifted onto the ground by triangle-grid raycast (XY AABB → bin by cell → barycentric check → interpolate Y + face normal). Candidates that miss every triangle (ground hole) are excluded. Per-blade orientation uses `(groundNormal, yaw)` so blades grow out of the surface on slopes.
**Causal status:** CAUSAL — without this, sculpted terrain shows grass floating or sunken.
**Scope:** `src/diorama/buildGrass.ts:sampleGroundAt` + per-bucket matrix composition in `buildBucketMesh`.
**Breaks when:** The ground's world-space AABB is invalid (caught with `isFinite(groundArea) && groundArea > 0`), or all its triangles are degenerate.
**Confirmed by:** 2026-04-22 — sculpted terrain followed by blades in ceebca7.
**Implication:** Grid resolution is 80×60 over the ground's AABB; O(k) per candidate where k is tris in the query cell (~1–5 for reasonable tessellation). One-time cost at build; zero per-frame cost.
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `src/diorama/buildGrass.ts` (groundTris array + sampleGroundAt closure).

### PV13: Sphere-mode rendering needs gap=0 AND face-boundary EDGE_OVERDRAW epsilon
**Statement:** Sphere cube-cell rendering must use `gap = 0` for the within-face clip planes (so halfCell reaches the face edges exactly) AND a small positive constant on the face-boundary planes (`(N±R)·p ≥ -EDGE_OVERDRAW`) so adjacent passes overlap by a sub-pixel sliver at cube edges. Either alone leaves a visible seam.
**Causal status:** STRUCTURAL — two distinct failure classes (a within-face sky strip and a cross-face hairline), each with its own cause, each requiring its own remedy.
**Scope:** `src/diorama/TileGrid.tsx:cubeCellRender` + the per-mode gap selection.
**Breaks when:** A future mode brings back a global sphere-terrain backfill (which would mask the within-face gap and let the sphere-mode gap revert).
**Confirmed by:** 2026-04-22 through 2026-04-23 — gap=0 in 257e58d, EDGE_OVERDRAW in 7ec4b34.
**Implication:** `CUBE_GAP = 0.06` stays as a cube/split-preview feature; sphere gets its own zero. EDGE_OVERDRAW = 1e-3 is safe — invisible overdraw, no z-fighting (same shader output by construction).
**Status:** IMPLEMENTED
**REF:** UNGROUNDED — `src/diorama/TileGrid.tsx` (mode-specific gap on line 589; EDGE_OVERDRAW on cubeCellRender's face-boundary planes).

### Entry Format (with mandatory REF)

```
### [ID]: [Name]
**Statement:** Wherever [A], necessarily [B].
**Causal status:** CAUSAL / STRUCTURAL / EMPIRICAL
**Scope:** [Where this holds]
**Breaks when:** [Where this doesn't hold]
**Confirmed by:** [Direct observation — date]
**Implication:** [What this means for design/debugging]
**Status:** IMPLEMENTED / NOT YET IMPLEMENTED / ALIGNED / MISALIGNED
**REF:** [Ground Truth doc]#[section] — `[source_file:line]` [what the code shows]
```

The `**REF:**` field creates the three-layer provenance chain:
```
Catalogue (compact invariant)  →  Ground Truth doc  →  source file:line
```
If no Ground Truth doc exists for this invariant's domain, create one using `~/.anvideck/projects/[project]/ref/GROUND_TRUTH_META_PROMPT.md`.

### PV14: Vertex-color layers ship as positional COLOR_0/1/2 — names are not preserved by the spec, so consumers MUST read by index AND authors MUST enforce list order
glTF semantic naming for color attributes is positional. Blender's importer auto-numbers as `Color`, `Color.001`, `Color.002`; three.js's GLTFLoader maps them to `geometry.attributes.color`, `color_1`, `color_2`. If the author swaps the painting on layer 0 vs. layer 1, the meaning silently swaps everywhere. Authoring tools must normalise list order; readers consume positionally.
**Implications:** Plugin's `_ensure_density_layers` reorders to canonical `grass / flowers / colliders`; `buildGrass.ts` reads `color`, `color_1`, `color_2` by name; `vite.config.ts:patchGlbColorAccessorNames` writes accessor.name post-export so Blender's UI shows the canonical names.
**REF:** UNGROUNDED — canonical instances `blender-plugin/rubics_world.py:_ensure_density_layers`, `src/diorama/buildGrass.ts:625`, `vite.config.ts:patchGlbColorAccessorNames`.

### PV15: The visible mesh is the source of truth; any authoring channel attached to a HIDDEN twin must be explicitly forwarded
Sphere mode hides flat `terrain` and renders `sphere-terrain`. Any property the author can edit on `terrain` (PBR scalars, vertex colors, UVs) must either (a) not be authored on the hidden mesh, or (b) be explicitly copied to the visible mesh at scene-build time. The implicit assumption "edits propagate" is false at this boundary.
**Implications:** `buildSphereTerrain(sourceMat?)` accepts a source material; TileGrid traverses for `terrain`'s material and passes it. Vertex-color authoring on flat terrain still works because buildGrass reads from the hidden mesh's geometry directly (a separate channel that doesn't need forwarding).
**REF:** UNGROUNDED — canonical instance `src/diorama/buildDiorama.ts:buildSphereTerrain` + `src/diorama/TileGrid.tsx:~628` (source traversal). Family: P23, P31.

### PV16: Bake-time scene-graph must be CPU-only; no FBO, no composite, no postprocessing
Offline glTF serialization runs on the scene graph that GLTFExporter walks — it doesn't need a renderer, doesn't write to FBOs, and doesn't trigger postprocessing. Bake routes (`/bake/`, `saveDiorama`) construct a throwaway root, manipulate it, run exporter.parse, dispose. They're decoupled from B4's FBO pipeline by construction. New bake-adjacent code must preserve this: never reach into `sphereTarget`, `quadRef`, or composer state.
**Implications:** `BakeRoute.tsx` mounts a non-rendering React tree. No `<Canvas>`, no `useFrame`. headless Chromium can drive it with software WebGL because zero per-frame load → zero stall.
**REF:** UNGROUNDED — canonical instances `src/BakeRoute.tsx`, `src/diorama/TileGrid.tsx:saveDiorama`. Distinguishes from B4 (live render path).

### PV17: Authored layer ordering is the round-trip contract
For dual-channel-mask authoring (grass density / flower density / walk colliders / etc), the AUTHORING TOOL (Blender plugin) and the READER (three.js side) must agree on ordering. Names get lost; positions don't. Plugin enforces the order at "ensure" time (rebuilding from scratch if mis-ordered); reader trusts the order.
**Implications:** Adding a 4th canonical layer requires updating BOTH sides simultaneously. A future "wind", "moisture", "snow" layer would be COLOR_3 → `color_3`.
**REF:** UNGROUNDED — canonical instance `blender-plugin/rubics_world.py:DENSITY_LAYERS` and `LAYER_ALIASES` migration table.

### PV18: All v-axis position formulas across the cube/sphere stack must use a single sign convention
The cube/sphere stack contains EIGHT independent functions that compute or invert the (face, u, v) → 3D position mapping: `cubeCellRender`, `storeTileCubeRender`, `buildOverlayLines` (cube + sphere), `CubeLabels`, `SphereLabels`, `audio/sphereProject.cubeNetToSphere`, `tileCentroid`, `centroidToFaceUV`, plus `tile.ts:isSolved`'s inlined formula. These are physically independent expressions — there's no shared helper that they all call. They MUST agree on the sign of `vOff = ± (v - 0.5) * CELL` (and the equivalent `t = ±(2v+1)/N − 1` for centroid math). Any pre-flip applied to localV/homeV in `buildCellDefs` or `tileToHome` must NOT be used to mask a sign disagreement between these consumers — it gives visually-correct output until you touch one of them, then the others diverge.
**Implications:** When changing the v-axis convention: change ALL of the above in one commit. Use `grep -E "(0\.5 - .*v|.*v - 0\.5|\(2 \* v \+ 1\) / N)" src/` to enumerate. Keep a single comment block (in `rotation.ts:tileCentroid`) that owns the convention statement; every other site references it.
**Family:** P39, P40.
**REF:** UNGROUNDED — canonical instances `src/world/rotation.ts:tileCentroid`, `src/diorama/TileGrid.tsx:cubeCellRender + storeTileCubeRender + buildCellDefs + buildOverlayLines`, `src/world/TileLabels.tsx:CubeLabels + SphereLabels`, `src/world/audio/sphereProject.ts`, `src/world/tile.ts:isSolved`.

### PV19: FACES table is the forward source of truth, but `centroidToFaceUV` is the inverse — both must move together
The forward direction (face index → 3D centroid) cascades automatically: every consumer reads `face.normal/right/up`. The inverse direction (3D centroid → face index) does NOT — `centroidToFaceUV` uses a hand-coded ternary (`c.x > 0 ? 0 : 1`, `c.y > 0 ? 2 : 3`, `c.z > 0 ? 4 : 5`) that hardcodes which face index lives at which axis sign. When FACES bases are rotated such that face indices swap physical positions (e.g. C/D pair-rotation), the dispatch must flip in lockstep. NEIGHBOR_IDX rebuilds correctly at module load because it goes through `centroidToFaceUV` — but only if that function is updated.
**Implications:** Any FACES edit that moves a face index across an axis sign requires a paired ternary flip in `centroidToFaceUV` (and audit of any other inverse mappings). Slice rotation, AI seed, hit-testing all depend on this.
**Family:** P42.
**REF:** UNGROUNDED — canonical instance `src/world/rotation.ts:centroidToFaceUV` (lines 28-33). Caller chain: NEIGHBOR_IDX → tileInSlice → rotateSlice → store.
