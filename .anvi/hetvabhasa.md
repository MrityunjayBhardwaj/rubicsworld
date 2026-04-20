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

## P8: Depth-derived normal reconstruction breaks on custom vertex displacement
**Root cause:** Occlusion passes like N8AO reconstruct surface normals by taking DEPTH DELTAS between neighbouring screen pixels and unprojecting. This assumes depth varies smoothly and linearly with screen position. A vertex shader that displaces geometry non-linearly (sphere projection, bezier height curve) produces valid-but-discontinuous depth at tile seams → normal reconstruction yields garbage → `finalAo = 1.0` (no occlusion) everywhere.
**Detection signal:** N8AO enabled with aggressive params shows zero AO. AO-only debug mode renders pure white. DoF on the same scene works correctly (confirms depth IS populated). Extreme params (radius 30, screen-space mode) don't help.
**The trap:** Tuning params endlessly; fiddling with depth format; patching n8ao's shader (open-ended). Root fix: **use SSAO** (`@react-three/postprocessing`'s classic `<SSAO>`) — it uses sampled hemisphere with explicit normal pass input, NOT depth-derived normals. Works on displaced-geometry scenes where N8AO fails.
**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` (dual N8AO + SSAO exposure). Diagnosis: `src/diorama/TileGrid.tsx:patchMaterialForSphere` displaces vertices; N8AO's neighbour-delta normal reconstruction in `node_modules/n8ao/dist/N8AO.js` assumes smooth depth.

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
