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
