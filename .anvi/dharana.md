# Dharana Catalogue — RubicsWorld

> Project-specific focused attention — the 4th Anvi catalogue. Dharana
> instantiates global principles into "for THIS project, check THESE
> specific things at THESE specific boundaries."
>
> Dharana derives FROM the other three catalogues: hetvabhasa clustering
> populates the boundaries section, vyapti spans populate the alignment
> section, krama crossings populate the health section. It completes the
> system: hetvabhasa = what went wrong, vyapti = what must hold, krama =
> what order, **dharana = where to focus**.
>
> This catalogue grows across sessions. Load at session start.
>
> **Maintenance:** Re-derive after any catalogue update. Entries not
> relevant for 3+ sessions are flagged for review — read WHY before
> pruning. After structural refactors, re-validate all entries against
> current code, then re-derive from updated catalogues.
>
> **Promotion criteria:** Single occurrence goes to memory, not dharana.
> Recurrence (2+ sessions) promotes to a dharana entry with full
> provenance. This prevents bloat from one-off surprises while ensuring
> real patterns get captured.

## 1. Project Boundaries

> Every system boundary in this project. For each: known silent-failure
> modes (from hetvabhasa), what to observe on THEIR side (instantiated
> boundary-pair observation), and a REF to the Ground Truth doc that
> traces the boundary's pipeline.

### Entry Format (MANDATORY fields)

```
### B[N]: [Our Module] <-> [Their Module]
FILES: [comma-separated list of source files at this boundary — used by hook for deterministic matching]
ORIGIN: [What observation or failure created this entry — be specific]
WHY: [What class of problems would be invisible without tracking this boundary]
HOW: [What observation targets / checks this boundary entry enables]
**REF:** [Ground Truth doc]#[section] — `[source_file:line]` [what the code shows]

**Silent-failure modes:** (from hetvabhasa entries that cluster here)
- [Mode 1 — hetvabhasa ref]
- [Mode 2 — hetvabhasa ref]

**Observation targets (THEIR side):**
- [What to check on the other side of the boundary]
- [Specific param names, formats, or protocols to verify]

**Fatality status:** BELOW THRESHOLD / APPROACHING (2 patterns) / FATALITY (3+ patterns)
```

_(Add boundaries as discovered. A boundary with 3+ hetvabhasa patterns_
_clustering at it is an organizational fatality signal — the boundary_
_itself may be drawn wrong.)_

### B1: [Example — Your Code] <-> [Example — External System]
ORIGIN: hetvabhasa entries H_, H_, H_ all cluster at this boundary
WHY: Without this boundary tracked, [class of bugs] are found one at a time instead of recognized as a structural class
HOW: [Specific observation targets and checks enabled by tracking this boundary]
**REF:** GROUND_TRUTH_[SYSTEM].md#[section] — `[file:line]` [what the code shows]

**Silent-failure modes:**
- [Describe mode — links to hetvabhasa entry]

**Observation targets (THEIR side):**
- [What to verify on the external system's side]

**Fatality status:** BELOW THRESHOLD

### B2: R3F scene <-> @react-three/postprocessing EffectComposer
FILES: src/world/PostFx.tsx, src/world/RealismFX.tsx, src/App.tsx, node_modules/@react-three/postprocessing/dist/index.js
ORIGIN: DoF cursor-follow silently broke after every Leva slider drag (PR #15, 2026-04-21). Took 3 rounds of attempted fixes before landing on the root cause: the postprocessing wrapper re-instantiates its imperative effect on every prop change via useMemo, orphaning any prop-attached mutable ref.
WHY: Without this boundary tracked, every new effect we want to drive from our own animation loop (DoF target, future SSAO focus, bloom mask reference, etc.) will be built with the same broken prop-based attachment pattern and silently break on the first slider drag.
HOW: Treat any `@react-three/postprocessing` wrapper prop that accepts a mutable object reference as unreliable. Use `useRef` on the effect instance + per-frame identity check in `useFrame` to re-attach. Canonical pattern lives in `feedback_library_ref_attachment.md`.
**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` DoF target re-attach

**Silent-failure modes:**
- Mutable-ref prop works at mount, silently breaks on first slider drag (P4)
- Shader chunk collision when merging effects in one EffectPass (P7)
- Deprecated prop alias silently changes units between library major versions (P6)
- Constructor-only option assigned at runtime creates a stray JS property that no uniform reads — self-state looks correct, GPU shader stays at default (P22)

**Observation targets (THEIR side):**
- `effect.target === ourVec3` identity check each frame
- Inspect `EffectPass.effects` array for chunk-collision risk (look for duplicate `#include` references)
- CHANGELOG of the library when upgrading postprocessing versions
- For every per-frame imperative write on a postprocessing effect, grep the class body in `node_modules/postprocessing/build/index.js` for a real `get <name>` / `set <name>`. If only the constructor reads it, route the write through the inner material's uniform path instead (e.g. `effect.cocMaterial.focusRange`, not `effect.worldFocusRange`).
- Probe `effect.<innerMaterial>.uniforms.<name>.value` to verify the uniform is actually changing — never trust the fact that `effect.<name>` reads back your set value, because plain JS properties are setter-free by default.

**Fatality status:** FATAL (4 patterns clustered — P4, P6, P7, P22). This boundary should be a first-class reference doc with every known safe/unsafe write pattern enumerated.

### B3: Project three.js <-> stale library pinned to older three
FILES: patches/realism-effects+1.1.2.patch, src/world/RealismFX.tsx, package.json, node_modules/realism-effects/dist/index.js
ORIGIN: realism-effects 1.1.2 peer-pinned to three ^0.151; we're on three 0.183 (PR #15, 2026-04-20). Multiple API removals/renames between versions broke module import.
WHY: Without this boundary tracked, we'd have downgraded three (breaking drei/R3F/HDRI) or forked the library (owning shader maintenance forever). The next stale-library-on-modern-three scenario would eat days.
HOW: Use patch-package for targeted rewrites. Typical drift: `WebGLMultipleRenderTargets` removed, `copyFramebufferToTexture` arg swap, `.texture[]` → `.textures[]`, GLSL function renames. If patch exceeds ~500 lines or touches GLSL heavily, abandon; find alternative.
**REF:** UNGROUNDED — canonical instance `patches/realism-effects+1.1.2.patch`

**Silent-failure modes:**
- Module import fails at load time (missing export from three)
- Runtime `TypeError: X is not a function` (renamed method)
- Shader compile errors (`unrecognized pragma`, `function already has a body`)

**Observation targets (THEIR side):**
- `npm view <lib> peerDependencies` vs our three version at install time
- grep installed dist for removed three classes (`WebGLMultipleRenderTargets`, old method signatures)
- GLSL chunks referenced via `#include` — check against current three ShaderChunk registry

**Fatality status:** BELOW THRESHOLD (one pattern — P5 — but 5 distinct drift types in a single library)

### B4: Offscreen composite <-> depth-dependent post-effects (DoF, AO, SSGI)
FILES: src/world/PostFx.tsx, src/diorama/TileGrid.tsx (sphereTarget FBO + composite quad), node_modules/n8ao/dist/N8AO.js, node_modules/postprocessing/build/index.js
ORIGIN (expanded 2026-04-23): Two distinct silent failures have clustered here — N8AO produces zero occlusion on the sphere (P8, 2026-04-21); sphere-mode composite quad writes only color, leaving the main framebuffer's depth attachment at clear value → every depth-gated post effect silently loses its signal (P21, 2026-04-23). Third related pattern: render-path optimization that omits a mesh from the diorama root for "it's drawn elsewhere" reasons breaks introspection-based consumers that traverse the same tree (P23, 2026-04-23 — buildGrass lookup failure on imperative sphere mode).
WHY: This boundary is where a private custom render path (24 per-tile renders to an offscreen FBO, then composite back) hands control back to a library pipeline (EffectComposer) that expects "a normal scene rendered to my inputBuffer." Every silent-failure mode here stems from ONE of the two sides making an assumption the other side doesn't honor — the library assumes depth is written, the custom path assumes "output color is enough"; the library assumes meshes in the scene graph correspond to what renders, the custom path omits meshes for perf. Without tracking this boundary as FATAL, each new depth-dependent effect and each new scene-graph consumer re-discovers the same class of bug.
HOW:
- Every offscreen-to-main composite MUST write both color AND depth. For the sphere composite quad: sample `sphereTarget.depthTexture` and assign to `gl_FragDepth`; set `depthWrite:true`, `depthTest:false` (we own the value). Check at review time: if a composite shader omits depth write, block the PR.
- Every optimization that "removes a mesh from the tree because it's drawn elsewhere" MUST separate presence from visibility. Keep the mesh in the tree (introspecting consumers find it); toggle `.visible=false` (renderer skips draw). Rule of thumb: if you're about to write `if (condition) root.add(mesh)`, ask "does any non-renderer consumer traverse this root?" If yes, always add and use `.visible` instead.
- AO passes on this boundary: prefer explicit-normal-pass effects (SSAO) over depth-derived normal reconstruction (N8AO) while sphere projection is active.
**REF:** UNGROUNDED — canonical diagnosis in `src/world/PostFx.tsx` (dual N8AO + SSAO exposure); `src/diorama/TileGrid.tsx:500-527` (composite quad with gl_FragDepth write); `src/diorama/TileGrid.tsx:hideFlatTerrainInSphereMode` (presence-vs-visibility helper for buildGrass).

**Silent-failure modes:**
- N8AO AO-only debug renders pure white (finalAo=1 everywhere; P8) — depth-derived normal reconstruction fails on displaced geometry.
- DoF / AO / SSGI see cleared far-plane depth everywhere the planet renders if the composite quad doesn't write `gl_FragDepth` (P21).
- Render-path optimization removes a mesh from the root that a sibling consumer (buildGrass) traverses for name/bounds — lookup returns null, consumer emits its "gracefully handled" error, feature silently missing (P23).

**Observation targets (THEIR side):**
- N8AO compositor `renderMode=1` (AO-only) screenshot — should NOT be all white on a scene with geometry.
- Toggle the composite quad's fragment shader to output depth as grayscale (`gl_FragColor = vec4(vec3(pow(depth, 512.0)), 1.0)`) — should render a proper depth gradient across the planet; black/empty means depth chain is broken.
- For any render optimization, enumerate OTHER consumers of the same scene graph before deleting/omitting a mesh. Traverse-based consumers (`buildGrass`, raycast-target walkers, bounds-based camera framers) are the easy-to-miss siblings.
- Probe `__dofEffect.cocMaterial.uniforms.depthBuffer.value` — should be a `DepthTexture` named `EffectComposer.StableDepth`. If null or empty, the composer didn't receive depth.

**Fatality status:** FATAL (3 patterns clustered — P8, P21, P23). Pattern shape is "custom render path makes an assumption the library side silently disagrees with."

## 2. Active Invariant Spans

> Which vyapti entries currently span multiple modules. When an invariant
> spans modules, it cannot be enforced in one place — that's a structural
> risk. Track alignment status to know which invariants need consolidation.

### Entry Format

```
### [Vyapti ID]: [Invariant Name]
ORIGIN: [Which vyapti entry and what observation triggered span tracking]
WHY: [What breaks if this span is not tracked — e.g., enforcement leaks across N files]
HOW: [What consolidation or alignment this enables]
**REF:** [Ground Truth doc]#[section] — `[source_file:line]` [what the code shows]

**Spans:** [Module A], [Module B], [Module C]
**Current boundary:** [Where the module boundary currently sits]
**Invariant says:** [Where the boundary should sit based on the invariant's span]
**Status:** ALIGNED / MISALIGNED / CONSOLIDATION PLANNED
```

_(Add invariant spans as discovered. MISALIGNED entries are active risks —_
_each one is a place where the invariant can leak.)_

## 3. Lens Configuration

> Which diagnostic lens axes are most active for this project, any
> project-specific axes created through blind spot detection, and
> observation targets at each depth for this project's boundaries.

### Active Axes

| Axis | Relevance | Notes |
|------|-----------|-------|
| Data-flow | HIGH / MEDIUM / LOW | [Why this axis matters for this project] |
| Timing | HIGH / MEDIUM / LOW | [Why] |
| Ownership | HIGH / MEDIUM / LOW | [Why] |
| Boundary | HIGH / MEDIUM / LOW | [Why] |

### Project-Specific Axes

```
### [Axis Name]
ORIGIN: [The observation that didn't fit any existing axis]
WHY: [The class of problems this axis now covers]
HOW: [What observation targets / checks this axis adds]
**REF:** [Ground Truth doc]#[section] if applicable
```

_(Add project-specific axes only when an observation doesn't fit any_
_existing axis. Don't create speculative axes.)_

### Observation Targets by Depth

| Boundary | Surface | Shallow | Deep |
|----------|---------|---------|------|
| B1 | [Quick check] | [Targeted investigation] | [Full trace] |
| B2 | [Quick check] | [Targeted investigation] | [Full trace] |

## 4. Organizational Health

> Fatality test results: do error patterns cluster at boundaries? Do
> invariants span too many modules? Do lifecycles cross boundaries too
> often? Any YES answer means the organization itself may be the bug.

### Fatality Test

| Check | Result | Details |
|-------|--------|---------|
| 3+ hetvabhasa patterns cluster at same boundary? | YES / NO | [Which boundary, which patterns] |
| Any vyapti spans 3+ modules? | YES / NO | [Which vyapti, which modules] |
| Any krama lifecycle crosses boundaries 3+ times? | YES / NO | [Which lifecycle, which crossings] |

**Overall:** HEALTHY / APPROACHING FATALITY / FATALITY — RESTRUCTURE

### Boundaries Approaching Threshold

_(Boundaries with 2 hetvabhasa patterns — not yet 3, but watch closely.)_

- [Boundary] — patterns: [H_, H_] — one more and this is a fatality signal

## 5. Ground Truth Inventory

> Which reference systems have Ground Truth docs, which source code has
> been downloaded, which pipeline stages are traced vs. opaque, and
> when each doc was last verified against current source.

| System | Source Downloaded? | Ground Truth Doc | Stages Traced | Opaque Regions | Last Verified | Dependency Version |
|--------|-------------------|-----------------|---------------|----------------|---------------|-------------------|
| [System A] | YES / NO | `GROUND_TRUTH_[A].md` | N/M | [List] | [Date] | [Version] |
| [System B] | YES / NO | `GROUND_TRUTH_[B].md` | N/M | [List] | [Date] | [Version] |

_(Add a row for every external system the project depends on. Systems_
_without Ground Truth docs are opaque boundaries — prioritize creating_
_docs for boundaries where hetvabhasa patterns cluster.)_

---

## When to Update Dharana

| Trigger | Action |
|---------|--------|
| **Project init** | Create dharana — scan codebase for boundaries, read existing catalogues, instantiate global principles. Every entry gets ORIGIN/WHY/HOW/REF. Create Ground Truth docs for external dependencies. |
| **Session start** | Validate dharana — have catalogues changed? Are boundaries still accurate? Flag stale entries. Check Ground Truth staleness against dependency versions. |
| **After any catalogue update** | Re-derive affected sections. Does new hetvabhasa create boundary clustering? Does new vyapti span a new module? Add entry with provenance pointing to the new catalogue entry. Every new entry must have a REF. |
| **After fix that took >1 attempt** | Gap check — did dharana cover this? If not, add entry. ORIGIN = "this fix required N attempts because [specific blind spot]." If at an external boundary, check/create Ground Truth doc. |
| **After blind spot detection** | New axis in lens configuration. ORIGIN = observation that didn't fit. WHY = class of problems now covered. |
| **After hitting an opaque boundary** | Download source, create Ground Truth doc, wire REFs from all catalogue entries at this boundary. |
| **Session end** | Save observations not yet promoted to dharana into memory. Next session, check recurrence — promote if 2+. |

## Composition Pairs

> When multiple fixes or features interact, verify composition — not just
> individual correctness. List pairs where one change's output flows
> through another change's path.

| Pair | Why They Interact | Verification |
|------|-------------------|-------------|
| [Change A] x [Change B] | [Output of A flows through B's path] | [How to verify the composition] |
