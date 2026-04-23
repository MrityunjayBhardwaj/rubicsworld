# Hetvābhāsa Catalogue — RubicsWorld

> Project-specific reasoning error patterns. Grows across sessions. Load at session start.
>
> **Entry structure:** Root cause first, then detection signal, then the trap
> (how it seduces you into workarounds). Entries teach you to recognize the
> ROOT FIX, not the cascade of bad attempts that precede it.
>
> **Maintenance:** At every 10th entry, review all entries. Remove any that
> are too specific to one bug (not generalizable), contradict a newer entry,
> or describe a pattern the codebase no longer has. Stale entries create
> false pattern-matching.
>
> **Quality-filtered growth (sādhanā):** Only add entries from high-quality
> diagnoses — bugs where the root cause was correctly identified in one pass
> without workaround attempts. Entries born from confused, multi-attempt
> debugging sessions capture the confusion, not the insight. If it took 3
> attempts to find the cause, distill ONLY the final understanding into
> the entry — not the journey.

## Universal Error Patterns

### U1: Timing Error (Krama Violation)
**Root cause:** The dependent operation is async. Your code runs before it completes.
**Detection signal:** Method call has no effect, returns null/undefined, or operates on uninitialized state.
**The trap:** You see the no-op and add a retry, setTimeout, or polling loop — which works sometimes, depending on timing. The root fix is to run your code INSIDE the async callback, not after it.

### U2: Identity Error (Object Mutation Assumption)
**Root cause:** The method returns a new object. Your property is on the old one.
**Detection signal:** Property you set is missing on the object downstream in the chain.
**The trap:** You set the property again downstream, or add it to the prototype (global leak). The root fix is to tag the RETURN VALUE of the method, not the input.

### U3: Scope Error (Prototype Collision)
**Root cause:** The framework owns the prototype. Your installation runs before the framework's, and gets overwritten.
**Detection signal:** Your interceptor/wrapper is never called despite being installed.
**The trap:** You install it "harder" (non-configurable, frozen) which breaks the framework. The root fix is to install AFTER the framework, or inside its initialization hook.

### U4: Observation Error (Mock Divergence)
**Root cause:** The mock doesn't replicate the real system's transformations on inputs/outputs.
**Detection signal:** Tests pass, production fails. The specific failure involves data shape or type that the mock never tested.
**The trap:** You fix the production code to handle the unexpected shape, but the mock still doesn't test it — so regression is invisible. The root fix is to test through the real pipeline for critical paths.

### U5: Workaround Error (Symptom Suppression)
**Root cause:** The underlying system doesn't have the information it needs.
**Detection signal:** Cascading fixes — each fix creates a new symptom. "Fixed A, now B is broken. Fixed B, now C."
**The trap:** Each individual fix is small and seems reasonable. The cascade feels like bad luck. The root fix is always at the data source — give the system the information it's missing (e.g., container dimensions, correct argument type, proper initialization).

### U6: Mutation-for-Observation Error
**Root cause:** Observation requires a tap into the data flow, but you redirected the flow instead of tapping it.
**Detection signal:** The thing you're observing works, but everything else on the same data path breaks.
**The trap:** You try to "fix" the broken paths by duplicating the data, creating a fork. The root fix is a passive side-tap (read-only connection) instead of a redirect.

## Project-Specific Error Patterns

_(Add entries as discovered. Follow the format below.)_
_(At every 10th entry: review, prune stale/non-generalizable entries.)_

## P1: Under-subdivided long geometry disappears under sphere projection
**Root cause:** Sphere mode's additive vertex shader curves vertices individually, then the rasterizer linearly interpolates between them. A `BoxGeometry` (or any primitive) spanning more than ~one cube face with only the default 1 segment has no intermediate vertices — the interpolation cuts a straight CHORD through the sphere interior, landing below the global SphereGeometry terrain. The mesh is rendered but occluded everywhere. Bezier height compression at low rawHeight makes the chord dip even further below radius 1.0.
**Detection signal:** Mesh is invisible in sphere mode but renders correctly in cube/split mode. Nearby small meshes on the same y level (dashes, posts) render fine. Bumping Y higher doesn't recover it. Changing color to bright red produces zero red pixels.
**The trap:** You blame z-fighting and bump Y (doesn't fix it because the chord still dips below), or blame clip planes / material flags / depthWrite (all fine). Root fix: add enough `widthSegments` (and `depthSegments` for long z-axis spans) that the shader has vertices to curve. Rule of thumb: ≥ ~8 segments per cube-face-block the mesh spans.
**REF:** UNGROUNDED — sphere projection shader lives in-project at `src/diorama/TileGrid.tsx:370-413` (the `<project_vertex>` replacement in `patchMaterialForSphere`). Road fix at `src/diorama/buildDiorama.ts:687-697` (`BoxGeometry(BASE_W, 0.025, ROAD_WIDTH, 64, 1, 1)`).

## P2: Sibling-mount race silently resets scene-level state
**Root cause:** Drei / R3F siblings (`<Environment>` re-mount paths, `<OrbitControls makeDefault>` mount/unmount) write `scene.environmentIntensity`, `scene.backgroundIntensity`, `scene.backgroundBlurriness`, `scene.environmentRotation` etc. to three.js defaults during their own lifecycle. If your push-to-scene lives in a store-dep `useEffect`, it won't re-fire when the store is unchanged — so the scene stays stuck at the reset values until the next user tweak reaches it through the store.
**Detection signal:** A slider works on first tweak, then silently "reverts" whenever an unrelated thing mounts/unmounts (walk-mode entry, bezier change, etc.). Store still shows the right value; scene shows the wrong one. No console errors. Can only catch it by reading `scene.*` live.
**The trap:** Expand `useEffect` dependencies hoping to catch the transition (`[scene, cameraMode, ...]`) — but other resets you haven't identified still slip through. Root fix: push scene-level state in `useFrame` (every frame, idempotent) so you always win the race. Cost: a handful of scalar assignments per frame.
**REF:** UNGROUNDED — canonical instance `src/world/HDRIEnvironment.tsx:48-62` (push moved from `useEffect` to `useFrame`). Diagnosis harness `tests/hdri-persist.mjs` snapshots store + scene across walk-mode entry.

## P3: React Strict Mode + `startedRef` guard = effect silently no-ops
**Root cause:** In dev, React Strict Mode invokes effects twice: mount → immediate cleanup → re-mount. A top-of-effect guard like `if (startedRef.current) return; startedRef.current = true;` sees `true` on the second mount and early-returns. The first mount's cleanup already aborted its `setTimeout` / subscription, so the intended behaviour never runs.
**Detection signal:** One-shot timed sequences (intros, cinematics, delayed bootstraps) fail to fire in dev but work in production (where Strict Mode is off). Diagnosable by logging at the top of the effect — you'll see the early-return line fire on the second mount.
**The trap:** Move the guard ref out of the component (module-level boolean) — but that breaks component remount (route change) and still races HMR. Root fix: don't guard. Let the effect re-run on each mount; rely on cleanup (`clearTimeout`, `unsubscribe`) to abort correctly, plus a store-state gate at the top of the effect (`if (store.introPhase === 'done') return`) for idempotent skip after completion.
**REF:** UNGROUNDED — canonical instance `src/world/IntroCinematic.tsx:30-38` (Strict-Mode-compatible re-mount pattern).

## P4: React-wrapper-reinstantiated effect loses mutable ref props
**Root cause:** A library (e.g. `@react-three/postprocessing`) wraps an imperative instance (DoF effect, N8AO pass) in a `useMemo` whose deps include EVERY config prop. Changing any slider re-runs the memo → new instance → any mutable-ref prop (`target={vec3}`, `depthTexture={tex}`) is assigned to the NEW instance once, but our external in-place mutation pipeline still points at the old one. Re-attachment via `useEffect` / `useLayoutEffect` keyed on stable deps won't fire, because from React's POV nothing changed.
**Detection signal:** Feature works immediately after page load; silently breaks the first time any slider is touched. Works again after hard refresh.
**The trap:** Expanding `useEffect` deps to include every prop that MIGHT trigger a remount — fragile, misses new props. Root fix: **per-frame identity check** in `useFrame`: `if (ref.current.target !== ourVec3) ref.current.target = ourVec3`. Cheap, self-healing, survives any wrapper behaviour.
**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` (DoF target re-attach). Wrapper source `node_modules/@react-three/postprocessing/dist/index.js` (DepthOfField forwardRef — useMemo with full prop list).

## P5: Library-version API drift — pre-r163 three.js libs need patch-package surgery on modern three
**Root cause:** A library peer-pinned to three ^0.151 (e.g. realism-effects 1.1.2) imports classes/functions that three.js removed or renamed in r163+: `WebGLMultipleRenderTargets` (removed), `copyFramebufferToTexture(pos, tex)` arg order (flipped), `OptimizedCineonToneMapping` GLSL function (renamed to `CineonToneMapping`), `renderTarget.texture[]` array (now `.textures[]`; `.texture` is a scalar getter).
**Detection signal:** Import fails at module load (missing export), OR runtime `TypeError: X is not a function`, OR shader compile error (`'X' : function already has a body` / `unrecognized pragma`). Cascades: fix one, another surfaces.
**The trap:** Pinning three backwards to match the library — breaks drei, R3F v9, HDRI, everything else on modern three. Forking the library — owns maintenance forever. Root fix: **patch-package** for targeted rewrites (3-round patch covers most drift). If patch grows past ~500 lines, the library is too stale — wait for upstream or use alternative.
**REF:** UNGROUNDED — canonical instance `patches/realism-effects+1.1.2.patch` (5-round patch). Wrapper `src/world/RealismFX.tsx`.

## P6: Deprecated prop aliases silently change units between major versions
**Root cause:** A library renames a prop across versions but keeps the old name as a deprecated alias pointing at the new semantics. Example: postprocessing 6.x aliases `focalLength` → `focusRange`, and `focusRange` is now in **world units** (thickness of sharp slab), where `focalLength` in 5.x was in normalised depth space. A value of `0.12` that meant "quick falloff" in 5.x means "12 cm thick sharp slab" in 6.x — almost nothing in focus.
**Detection signal:** Effect visually broken in a way that scales weirdly — "everything is blurred regardless of zoom" or "only one pixel is sharp". Params look sane but produce absurd results.
**The trap:** Tuning the old param name by trial-and-error; never converges because the semantics changed. Root fix: **use the non-deprecated prop names** (`worldFocusRange` explicitly), check for unit changes in the library CHANGELOG, and label Leva sliders with units (`focus range (world)`).
**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` (DoF worldFocusRange).

## P7: Effect merging collides on shared shader chunks
**Root cause:** `@react-three/postprocessing`'s `EffectComposer` merges consecutive `Effect` children into a single `EffectPass` for perf. If two effects each `#include <tonemapping_pars_fragment>` (or any shared chunk), the merged fragment shader contains the chunk twice → `LinearToneMapping / CineonToneMapping / etc. : function already has a body` compile error.
**Detection signal:** Scene compiles fine with either effect alone; enabling both together throws WebGL shader compile errors referencing redefined functions.
**The trap:** Trying to #ifdef-guard the chunk, or editing the merged shader. Root fix: **put each colliding effect in its own EffectPass** (add them imperatively via `composer.addPass`). Costs one draw call per effect; buys independent shader scope.
**REF:** UNGROUNDED — canonical instance `src/world/RealismFX.tsx` (one EffectPass per realism-effect).

## P9: InstancedMesh invisible in sphere mode — custom vertex patch omits `instanceMatrix`
**Root cause:** `patchMaterialForSphere` replaces `#include <project_vertex>` with code that computes `vec4 worldPos = modelMatrix * vec4(transformed, 1.0)` — but for an InstancedMesh three.js normally multiplies `instanceMatrix` in the default chunk. Skipping it collapses EVERY instance onto the first instance's sphere-projected position, so thousands of blades render stacked on one dot and the field looks empty.
**Detection signal:** Instanced geometry (grass, flowers) renders fine in cube-net / split / cube previews but is completely invisible on the sphere. Non-instanced props sharing the same patched material look correct.
**The trap:** Checking frustum culling, clip planes, mesh counts, sphere-terrain depth ordering — all red herrings because the instance matrices ARE live and ARE correct. Root fix: **fold `instanceMatrix` into the patched vertex shader**. Three auto-declares `instanceMatrix` when USE_INSTANCING is defined; guard the branch:
```glsl
#ifdef USE_INSTANCING
  vec4 _os = instanceMatrix * vec4(transformed, 1.0);
#else
  vec4 _os = vec4(transformed, 1.0);
#endif
vec4 worldPos = modelMatrix * _os;
// also feed _os into vClipPosition for clipping
```
**REF:** UNGROUNDED — canonical instance `src/diorama/TileGrid.tsx:patchMaterialForSphere` (`#ifdef USE_INSTANCING` branch inside `<project_vertex>` override).

## P10: Calling `bpy.ops.wm.read_factory_settings` from inside a Blender operator segfaults on return
**Root cause:** `read_factory_settings` tears down the current scene graph, which invalidates the RNA PointerRNA the running operator is bound to. When `self.report(...)` or the implicit `return {'FINISHED'}` fires, Blender walks a dangling path and crashes in `RNA_property_collection_lookup_string_index`.
**Detection signal:** Blender crashes (EXC_BAD_ACCESS) with a stack topped by `pyrna_struct_path_resolve` → `rna_operator_exec_cb` immediately after a Python operator that internally calls `wm.read_factory_settings`. The operator's work DOES complete; the segfault happens on exit.
**The trap:** Wrapping the call in try/except or catching in the caller — neither sees the crash because it's inside the RNA teardown, not the Python layer. Root fix: **clear via the data API**, not the operator. `for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)` does not touch the calling operator's stack.
**REF:** UNGROUNDED — canonical instance `blender-plugin/rubics_world.py:RUBICS_OT_Import.execute`.

## P11: InstancedMesh `mesh.count` scaling chops the TAIL, not a uniform subset
**Root cause:** Three.js renders only the first `mesh.count` instances of an InstancedMesh. If the authoring order is grouped (e.g. all face-block E instances, then A, then B, ...), reducing count chops the end of the array — the last group disappears first, giving the illusion of face-by-face filling instead of uniform density thinning.
**Detection signal:** A density slider looks like it fills "patchy, face by face" instead of smoothly thinning the whole field. At 100% density it looks even; at 50% one group is gone entirely.
**The trap:** Debugging the sampler, re-computing face-block exclusions, tweaking the shader. The geometry IS correct — the render-order assumption is wrong. Root fix: **Fisher-Yates shuffle the instance array** (positions, yaws, scales, hues, plus any per-instance attribute) after sampling so any `mesh.count = N` subset is uniformly random across all source groups.
**REF:** UNGROUNDED — canonical instance `src/diorama/buildGrass.ts` (per-bucket shuffle before `setMatrixAt`).

## P12: glTF-loaded scenes explode material count → linear shader-compile cost on load
**Root cause:** The Blender glTF exporter instantiates a fresh material per mesh by default, even when two meshes use visually-identical properties. A 150-mesh diorama commonly arrives with 100+ unique materials. Any per-material `onBeforeCompile` patch (sphere projection, fresnel) then compiles that many shaders, and every hot-reload swap repeats the cost.
**Detection signal:** Scene takes seconds to appear after load; FPS recovers once it's up. Hot-reload swaps cause visible stalls. `scene.traverse` + Set of material.uuid reveals dozens more materials than visually distinct looks.
**The trap:** Blaming the exporter, suggesting Blender-side fixes, tuning the shader. Root fix: **dedupe materials after load** — walk the loaded scene, hash each material by (colour, PBR scalars, texture uuids, side, alphaTest), and replace duplicates with the canonical instance. Patches applied via idempotent `userData` guards (our sphere patch uses `__spherePatched`) so sharing is safe.
**REF:** UNGROUNDED — canonical instance `src/diorama/loadGlbDiorama.ts:dedupeMaterials`.

## P13: Blender `depsgraph_update_post` fires on non-authoring events
**Root cause:** The depsgraph handler fires on every re-evaluation: selection changes, viewport orbits, animation preview ticks, driver re-evals — not just geometry/transform mutations. Using it as a "scene changed" signal triggers constantly during normal interaction.
**Detection signal:** An auto-export / auto-save handler writes the file dozens of times per minute even when the user is just navigating. Console shows exports on every viewport rotation.
**The trap:** Adding debounce alone (still runs every tick on idle); adding an undo-post handler (still fires on selection). Root fix: **two-layer gate** — (1) filter `depsgraph.updates` by `is_updated_transform/geometry/shading` AND restrict to relevant datablock types (`Object`, `Mesh`, `Material`, `Action`, `Armature`); (2) compare a content fingerprint (blake2b over object transforms, mesh vert counts, modifier signatures, action ranges) before writing — skip if equal to the last exported fingerprint.
**REF:** UNGROUNDED — canonical instance `blender-plugin/rubics_world.py:_live_depsgraph_handler` + `_scene_fingerprint`.

## P14: Root transform contamination during post-mount scene-graph reads
**Root cause:** `TileGrid.tsx` overwrites `diorama.root.position/quaternion/matrix` every frame for its 24-pass per-cell rendering (see TileGrid.tsx:1075-1078, 1092-1095). Any helper called AFTER the mount that reads mesh.matrixWorld (setFromObject, applyMatrix4) picks up whichever cell transform happened to be set by the last render pass. Initial call (loadGlbDiorama during first mount) sees identity; subsequent calls (rebuildWithMask Leva button, HMR hot-reload swap rebuild) see the contaminated state.
**Detection signal:** A function that worked on initial load suddenly produces wrong results when invoked post-mount. In our case: "load mask" button clipped grass candidates to a tiny sliver clustered near one cube face, because the ground AABB read was in cube-space rather than root-local.
**The trap:** Debugging the helper itself, doubting the mask math, adding logging in the sampler. Root fix: **save / zero / restore the root's transform inside the helper.** Snapshot `root.position/quaternion/scale/matrix/matrixAutoUpdate`, reset to identity, `updateMatrixWorld(true)`, do the work, restore in a finally-guard. Cheap and localises the contract to the function that needs identity.
**REF:** UNGROUNDED — canonical instance `src/diorama/buildGrass.ts` (save/restoreRoot helpers) and `src/diorama/weldSeams.ts`.

## P15: USE_MAP (and other) shader defines are fixed at FIRST material compile
**Root cause:** three.js compiles a material's shader program once; chunk-level defines like USE_MAP, USE_NORMALMAP, USE_COLOR are gated on the presence of the relevant inputs AT COMPILE TIME. Adding a `map` to a live material only mutates the JS material object — the shader program stays the same and the bound texture is silently ignored. R3F auto-sets `needsUpdate` for some prop deltas but not for map-add/remove transitions.
**Detection signal:** A Leva toggle that binds/unbinds a texture on an existing material has no visible effect. Inspecting the material in the page shows `material.map` set and `material.map.image.complete` true, but the rendered output doesn't use the texture.
**The trap:** Calling `material.needsUpdate = true` manually (easy to forget on subsequent toggles), fighting the r3f lifecycle. Root fix: **`key` the material JSX element on the toggled-input truthiness.** When the key changes, React unmounts the old material and mounts a fresh one — three compiles with the correct defines from the start. Cheap (pooled material lifecycle) and sidesteps the needsUpdate dance entirely.
**REF:** UNGROUNDED — canonical instance `src/world/CubeSphere.tsx:TileMesh` (`key={grassMap ? 'grass' : 'plain'}`).

## P16: Sphere-mode within-face clip gap leaves sky strips after the global sphere-terrain is disabled
**Root cause:** Every cube cell uses `halfCell = (CELL - gap) / 2`. With `gap = CUBE_GAP = 0.06` the cell's clip planes stop `gap/2` short of the face edges. That gap was historically invisible because the full `buildSphereTerrain()` SphereGeometry was always rendered behind the per-cell passes. Once the global terrain is conditionally disabled (e.g. glb mode to avoid double-ground), the gap becomes a visible sky-coloured strip at every cube edge.
**Detection signal:** Clean cube-edge seams appear the moment you add a "disable global terrain" branch for glb / scripted scenes; worse after any refactor that drops a full-sphere backfill.
**The trap:** Searching for z-fighting, tweaking anti-aliasing, suspecting the seam-weld output. Root fix: **mode-specific gap — 0 in sphere mode.** Cube/split previews keep their gaps (intentional visual separators); sphere pipeline uses gap=0 so within-face planes reach the face edges exactly. Face-boundary planes (constant 0) then handle the cross-face transition.
**REF:** UNGROUNDED — canonical instance `src/diorama/TileGrid.tsx:589` (`const gap = mode === 'split' ? SPLIT_GAP : mode === 'cube' ? CUBE_GAP : 0`).

## P17: Hairline cube-edge gaps from float precision at exact-zero face-boundary clip planes
**Root cause:** `cubeCellRender`'s face-boundary planes use `(N±R)·p ≥ 0` and `(N±U)·p ≥ 0` with plane constant EXACTLY 0. Two adjacent face passes are designed to meet at the cube edge mathematically, but each pass's own per-cell transform (position × quaternion) computes the shared edge's cube-space position with ordinary float precision. One pass lands the same source vertex at `z = -1 + 2e-7`, the adjacent pass at `z = -1 - 2e-7`; neither plane keeps the strict-zero fragment → both discard → pixel-thin sky leak at every cube edge.
**Detection signal:** Hairline seams remain at cube edges even after within-face gap=0 fix; sky visibly shows through at A↔F, A↔C, etc.
**The trap:** Trying to tighten the per-cell transform math, hand-snapping vertex positions, subdividing more. Root fix: **small positive epsilon on face-boundary plane constants (EDGE_OVERDRAW ≈ 1e-3).** Adjacent passes overlap by a sub-pixel sliver; the neither-covers scenario becomes a both-covers (invisible overdraw — same shader output by construction). Within-face planes still use exact halfCell (same-transform boundaries don't suffer cross-transform drift).
**REF:** UNGROUNDED — canonical instance `src/diorama/TileGrid.tsx:cubeCellRender` (EDGE_OVERDRAW on lines 231-238).

## P18: mergeVertices keeps first-seen vertex's normal — seam-duplicate collapse pinches lighting
**Root cause:** `three/examples/jsm/utils/BufferGeometryUtils.mergeVertices(geom, eps)` collapses near-duplicate positions and carries over the first-seen vertex's entire attribute stack (normal, uv, color). When two formerly-duplicate verts sat on opposite sides of a face seam with flat-shaded normals (each triangle's own normal), the survivor inherits just ONE triangle's normal → the "pinch" is a thin line of wrong lighting.
**Detection signal:** Visible lighting discontinuity at face seams after Phase A seam weld, even though positions now line up.
**The trap:** Reverting the weld, adjusting the merge tolerance, assuming the sphere-projection shader's normal override should cover everything (it only fully overrides at rawHeight=0). Root fix: **`geometry.computeVertexNormals()` on the ground mesh after the weld.** Averages adjacent-triangle normals per vertex, fixing both flat-shaded Blender exports and weld-induced pinches in one pass. Scope to the ground; other meshes keep their authored hard edges on purpose.
**REF:** UNGROUNDED — canonical instance `src/diorama/loadGlbDiorama.ts` (post-weld computeVertexNormals on name-matched ground).

## P19: Blender vertex-paint doesn't change vert/poly counts → topology-only fingerprint misses strokes
**Root cause:** Live Mode's scene fingerprint hashed `len(vertices)` + `len(polygons)` as a cheap change detector. Vertex Paint strokes mutate the COLOR_0 attribute's bytes without touching topology; the fingerprint stayed identical pre/post stroke and Live Mode short-circuited with "nothing changed" — paint never reached the glb.
**Detection signal:** Painting the ground in Blender with Live Mode on produces no glb rewrite, no HMR trigger in the browser, and the grass density doesn't update.
**The trap:** Increasing the debounce, assuming Blender's depsgraph handler didn't fire (it does — `is_updated_geometry` flips on paint). Root fix: **fold per-mesh color-attribute byte contents into the fingerprint.** For each mesh's `color_attributes` layers, `foreach_get("color", float[])` into a buffer and feed `buf.tobytes()` to the blake2b. Cost is ~16 bytes/vert per layer — negligible for a few-thousand-vert ground, catches every paint stroke.
**REF:** UNGROUNDED — canonical instance `blender-plugin/rubics_world.py:_scene_fingerprint` (color_attributes hashing branch).

## P20: `bpy.ops.mesh.primitive_plane_add` gives 2 triangles — insufficient for cube→sphere projection
**Root cause:** `primitive_plane_add` creates a 4-vert, 2-triangle plane regardless of its `size`. When that plane spans multiple face blocks (an Init-scene ground covers the full 8×6 cross), the two giant triangles are linearly interpolated in the sphere-projection shader's varyings — the interior passes through the sphere interior as a chord, not along the curved surface. Net visual: ground nearly invisible, grass emitter runs correctly but there's nothing underneath to render.
**Detection signal:** Exporting a fresh Init glb and loading in the app shows a blank/broken planet even though logs confirm loadGlbDiorama succeeded.
**The trap:** Adding an Edit-mode `mesh.subdivide` operator call (unreliable across Blender versions), fighting the sphere projection shader. Root fix: **construct the mesh via bmesh as a pre-subdivided grid** (we use 48×36 = 8 cuts per face on the middle row, matching PV1's ≥ ~8 subdivisions/face rule and buildTerrain's density). UVs span [0, 1] at construction so the cube-net alpha mask applies exactly once across the plane. Instance of project vyāpti PV1 — restated here because the Blender-side authoring surface is where the bug enters.
**REF:** UNGROUNDED — canonical instance `blender-plugin/rubics_world.py:RUBICS_OT_InitScene` (bmesh grid loop).

## P8: Depth-derived normal reconstruction breaks on custom vertex displacement
**Root cause:** Occlusion passes like N8AO reconstruct surface normals by taking DEPTH DELTAS between neighbouring screen pixels and unprojecting. This assumes depth varies smoothly and linearly with screen position. A vertex shader that displaces geometry non-linearly (sphere projection, bezier height curve) produces valid-but-discontinuous depth at tile seams → normal reconstruction yields garbage → `finalAo = 1.0` (no occlusion) everywhere.
**Detection signal:** N8AO enabled with aggressive params shows zero AO. AO-only debug mode renders pure white. DoF on the same scene works correctly (confirms depth IS populated). Extreme params (radius 30, screen-space mode) don't help.
**The trap:** Tuning params endlessly; fiddling with depth format; patching n8ao's shader (open-ended). Root fix: **use SSAO** (`@react-three/postprocessing`'s classic `<SSAO>`) — it uses sampled hemisphere with explicit normal pass input, NOT depth-derived normals. Works on displaced-geometry scenes where N8AO fails.
**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` (dual N8AO + SSAO exposure). Diagnosis: `src/diorama/TileGrid.tsx:patchMaterialForSphere` displaces vertices; N8AO's neighbour-delta normal reconstruction in `node_modules/n8ao/dist/N8AO.js` assumes smooth depth.

## P21: Offscreen-composite quad that samples only color silently breaks every depth-gated post-effect
**Root cause:** Sphere mode renders the whole diorama to `sphereTarget` (a drei `useFBO`-allocated render target) and composites back into the main R3F scene via a fullscreen quad. If the quad's fragment shader writes ONLY color and leaves `depthWrite: false`, the main framebuffer's depth attachment holds the clear value (far plane) everywhere the planet renders. Every post effect that reads that depth — DoF circle-of-confusion, N8AO, SSAO, SSGI — sees "nothing at this pixel" and degrades silently: DoF applies bokeh globally regardless of focus target, AO reports no occlusion, SSGI/SSR march into the void. The color output looks correct so nothing obvious fires.
**Detection signal:** DoF `target` moves correctly (verified via `window.__dofTarget`), `worldFocusRange` is set, yet bokeh blurs the entire scene uniformly including the supposed focus point. N8AO/SSAO's AO-only debug mode returns pure white. The effects appear to be "working" at code level but have no depth signal to act on.
**The trap:** Tuning DoF params (bokehScale, focusRange, target smoothing) endlessly; blaming the effect library; assuming the raycast-published cursor position is wrong. Root fix: **request `{ depthBuffer: true }` on useFBO** (drei then attaches a `DepthTexture` — see `node_modules/@react-three/drei/core/Fbo.js:31`) and have the composite quad sample it + write `gl_FragDepth` (window-space [0..1] pass-through, no conversion needed). Flip quad material to `depthWrite: true`; `depthTest` stays off since we're authoritative on depth via `gl_FragDepth`. With this, the existing CoC / AO math finally has real per-pixel planet depth to gate against.
**REF:** UNGROUNDED — canonical instance `src/diorama/TileGrid.tsx` (sphereTarget FBO + composite quadMaterial at `quadRef`). Composite flow: `src/diorama/TileGrid.tsx:956-1118` renders to `sphereTarget`, then the `renderOrder={-1000}` quad samples it back into the main buffer.

## P22: Constructor-only option assigned at runtime is a dead write (postprocessing DoF `worldFocusRange`)
**Root cause:** `DepthOfFieldEffect` in postprocessing 6.x accepts `worldFocusRange` as a CONSTRUCTOR option (read once, written into `cocMaterial.focusRange` uniform), but exposes NO live `worldFocusRange` getter/setter on the effect instance. Per-frame `effect.worldFocusRange = X` therefore creates a stray property on the JS object that no shader uniform ever reads. The live setters live on `cocMaterial` — `cocMaterial.focusRange` (and the deprecated alias `cocMaterial.worldFocusRange`) write `cocMaterial.uniforms.focusRange.value`. Same trap pattern applies to any postprocessing effect whose constructor options look like mutable knobs but aren't.
**Detection signal:** Reading `effect.worldFocusRange` reports the last-assigned value, so debug logs of your own state look correct. But the rendered bokeh/blur doesn't change with the knob — it behaves as if the constructor default is frozen in. Probe `effect.cocMaterial.uniforms.focusRange.value` (or the equivalent uniform for your effect): if it's stuck at the default while your "setter" reports changes, you're writing to the wrong object. The gap between "my state says X" and "GPU sees Y" is the fingerprint.
**The trap:** Adding smoothing, retriggering the wrapper with key props, or assuming the React wrapper re-instantiation (P4) ate the value. Root fix: **write to the `cocMaterial` uniform path, not the effect object**. For DoF: `effect.cocMaterial.focusRange = value`. Before doing any per-frame imperative write on a postprocessing effect, check that the property has a real getter/setter defined on the CLASS in `node_modules/postprocessing/build/index.js` (search for `get <name>`/`set <name>` within the effect's constructor → the nearest class body). If only the constructor reads it, route through the inner material instead.
**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` (DoF focus-range ease between cursor-hover and whole-planet). Postprocessing source: `node_modules/postprocessing/build/index.js:5079-5096` (`CircleOfConfusionMaterial.focusRange` getter/setter and the `worldFocusRange` deprecated alias); `DepthOfFieldEffect` constructor at line 5456 — note absence of any `worldFocusRange` property on the effect class.

## P23: Render-path optimization that omits a mesh breaks lookup-based consumers that traverse the same tree
**Root cause:** Two consumers read the same object tree for different purposes — one renders (draw calls), one introspects (name/bounds lookups). An optimization pass drops a mesh from the tree because the *renderer* doesn't need it (it's drawn separately, as a global, or replaced by another geometry). The *introspecting* consumer then silently fails the lookup and takes its error path. In RubicsWorld: sphere mode rendered a global `sphere-terrain` mesh for visual continuity, so `buildDiorama({ includeTerrain: mode !== 'sphere' })` omitted the flat `terrain` plane from the diorama root. But `buildGrass` traverses that same root looking for a mesh whose name starts with `terrain` to compute spawn AABB — no mesh → "no ground object found" → empty grass meshes returned. The imperative sphere scene shipped with no grass for weeks.
**Detection signal:** Feature X works on one code path (`?glb=1`: Blender export ships its own named `terrain` mesh) and silently fails on a sibling path (imperative build). Console shows the "gracefully handled" error message the consumer emits when its lookup returns nothing. Two facts hold simultaneously: (a) the renderer claims "everything renders correctly", (b) the feature that depends on the traversal is missing. The gap is that "what renders" and "what a sibling consumer sees" are divergent views of the same tree.
**The trap:** Assuming the missing feature is the consumer's bug (buildGrass must have a bug). Rewriting the consumer to handle the absence gracefully (it already does, and that's WHY it's silent). Root fix: **separate presence from visibility**. Keep the mesh in the tree so the introspecting consumer can find it; set `visible = false` so the renderer skips the draw call. three.js `Object3D.traverse()` visits invisible meshes; `WebGLRenderer.render()` skips them. Visibility is a render concern; presence is a tree-structure concern — optimizations should toggle the former, not the latter.
**REF:** UNGROUNDED — canonical instance `src/diorama/TileGrid.tsx:hideFlatTerrainInSphereMode` (traverse + visible=false helper applied after `buildDiorama({ includeTerrain: true })`). Consumer: `src/diorama/buildGrass.ts:452` (`if (!groundMesh) { console.error(...); return emptyGrassResult() }`).

### Entry Format (MANDATORY fields)

```
## [ID]: [Name]
**Root cause:** [What actually causes this]
**Detection signal:** [How you notice it]
**The trap:** [The wrong fix that's tempting]. Root fix: [the actual fix]
**REF:** [Ground Truth doc]#[section] — `[source_file:line]` [what the code shows]
```

The `**REF:**` field is MANDATORY for all project-specific entries. It creates the provenance chain:

```
Catalogue entry (compact pattern)
    ↓ REF: GROUND_TRUTH_*.md#stage-N
Interpretation (how/why/when + code citations)
    ↓ REF: file:line
Source code (ground truth)
```

If you cannot cite a Ground Truth doc, the entry is UNGROUNDED — mark it `**REF:** UNGROUNDED — [reason]` and prioritize grounding it by reading the relevant source code.

### Ground Truth Documents

Ground Truth docs are produced using the meta-prompt at `~/.anvideck/projects/[project]/ref/GROUND_TRUTH_META_PROMPT.md`. They trace a system's pipeline end-to-end with `file:line` citations for every behavioral claim. To create one:

1. Download the reference system's source code to `~/.anvideck/projects/[project]/ref/sources/[system_name]/`
2. Apply the meta-prompt with the source files as input
3. Output: `~/.anvideck/projects/[project]/ref/GROUND_TRUTH_[SYSTEM_NAME].md`
4. Update catalogue REF fields to point to the new doc
