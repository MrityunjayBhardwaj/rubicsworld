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
