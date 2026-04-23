# Krama Catalogue — RubicsWorld

> Project-specific lifecycle and timing patterns. Each entry documents
> a sequence of operations, what's sync vs async, common ordering
> violations, and how to verify correct ordering.
>
> Krama patterns prevent the most common class of bugs: things happening
> in the wrong order. They're the temporal equivalent of vyāptis.
>
> This catalogue grows across sessions. Load at session start.
>
> **Maintenance:** At every 10th entry, review all entries. Remove any that
> describe lifecycles of components that no longer exist, or that have been
> superseded by newer entries for the same component. When a lifecycle
> changes (e.g., sync becomes async in an update), update the entry.
>
> **Quality-filtered growth (sādhanā):** Only add lifecycle patterns that
> were verified by direct observation of execution order (debug logs,
> step-through, documented callback sequences). Inferred ordering ("it
> must be async because...") without observation is a hypothesis, not
> a krama entry.

## Entry Format

```
### [ID]: [System/Component Name]

**Lifecycle:**
1. [Step 1] — sync/async — owned by [who]
2. [Step 2] — sync/async — depends on [1]? how guaranteed?
3. [Step 3] — ...
N. [Your code can safely run here]

**Common violation:** [What people get wrong about this ordering]
**Detection:** [How to verify ordering is correct]
```

## Universal Krama Patterns

### UK1: Constructor → Async Setup → Ready
**Lifecycle:**
1. `new Framework(config, container)` — SYNC — creates instance, schedules setup
2. `setup()` / `onReady()` / `init callback` — ASYNC — creates internal state, DOM, resources
3. Instance is ready for method calls — depends on step 2 completing

**Common violation:** Calling instance methods between step 1 and step 2. The instance exists but isn't initialized. Methods are either no-ops or throw.
**Detection:** Log inside setup callback AND immediately after constructor. If post-constructor log fires first, methods called there are premature.

### UK2: Framework Init → Method Registration → User Code
**Lifecycle:**
1. Framework loads — SYNC — defines base classes
2. `initialize()` / `bootstrap()` — SYNC during framework's evaluate/run — registers methods on prototypes, sets up global state
3. User code executes — uses the registered methods

**Common violation:** Installing prototype interceptors before step 2. Step 2 overwrites them. The interceptor silently disappears.
**Detection:** After step 2, verify your interceptor is still in place (type check, reference comparison, or test call).

### UK3: Pipeline Transform → Execute Handler
**Lifecycle:**
1. User writes `obj.method("value")` — source code
2. Build pipeline rewrites the call — SYNC at compile/transform time — may wrap arguments
3. Transformed call executes at runtime — handler receives transformed arguments

**Common violation:** Handler assumes it receives the original argument type. The pipeline may have wrapped, coerced, or replaced it.
**Detection:** Log argument type and value inside the handler. Compare against what the user wrote.

### UK4: Install → Execute → Capture → Restore
**Lifecycle:**
1. Install interceptors (hooks, wrappers, traps) — SYNC — before scoped operation
2. Execute scoped operation — may be ASYNC — triggers interceptors
3. Interceptors fire during step 2 — capture data into external storage
4. Scoped operation completes
5. Restore original state — SYNC in finally block — MUST happen even on error

**Common violation:** Not restoring in `finally` block. If the scoped operation throws, interceptors remain permanently installed, corrupting global state.
**Detection:** After the scoped operation (success or failure), verify global state matches pre-operation state.

### UK5: Cleanup Old → Create New (Re-entry)
**Lifecycle:**
1. Trigger event fires (user action, code change, re-evaluation)
2. Cleanup previous state (DOM nodes, event listeners, resources) — SYNC — must complete before step 3
3. Execute new operation — may be ASYNC
4. Create new state from operation results — SYNC after operation completes

**Common violation:** Creating new state without cleaning up old state. Leads to duplicates, orphaned resources, memory leaks.
**Also:** Cleaning up state that should persist (e.g., destroying visible elements on pause instead of freezing them).
**Detection:** Check for orphaned resources, duplicate listeners, or growing memory after repeated trigger cycles.

## Project-Specific Krama Patterns

_(Add entries below as they're discovered during this project.)_
_(Each entry must include a `**REF:**` field pointing to a Ground Truth doc.)_

### PK1: React-wrapped imperative effect — mount, param-driven remount, every-frame update
**Lifecycle:**
1. `<DepthOfField .../>` mounts — SYNC — wrapper's `useMemo` creates the imperative effect instance; `ref.current` populated
2. `<primitive object={instance} target={vec3}>` assigns `instance.target = vec3` via R3F `applyProps` — SYNC at mount
3. Our `useFrame` begins running — mutates `vec3.x/y/z` each frame; effect's `update()` reads `this.target.x/y/z` via `calculateFocusDistance` — OK
4. User drags a Leva slider → component re-renders with new prop value → wrapper's `useMemo` deps change → creates NEW imperative effect instance → `ref.current` swapped → new instance's `.target` is the wrapper's internal placeholder Vector3, not ours — BROKEN
5. Our `useFrame` continues mutating old `vec3`, which the new instance doesn't read

**Common violation:** Attaching the target ref via `useEffect(..., [stableDeps])` once on mount. React doesn't know about the wrapper's silent re-memoisation, so the effect doesn't re-fire. Our mutations become orphaned.

**Detection:** Feature works on page load, silently breaks on first slider drag. Comes back after hard refresh. Expose the effect instance via `window.__x` and compare `window.__x.target === ourVec3` across slider drags — will flip to `false` after the first drag.

**Root fix:** Per-frame identity check INSIDE useFrame:
```tsx
useFrame(() => {
  if (!ref.current) return
  if (ref.current.target !== ourVec3) ref.current.target = ourVec3
  // safe to mutate ourVec3 now
})
```

**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` DoF target re-attach. Wrapper remount confirmed at `node_modules/@react-three/postprocessing/dist/index.js` DepthOfField `useMemo` (deps include all config props).

### PK2: Leva useControls arg positions
**Lifecycle:**
1. User calls `useControls(folderName, schema, ???)` — SYNC — Leva registers the controls in the store
2. Leva treats the third positional arg as **deps array**, NOT a settings object like `{collapsed: true}`
3. If a non-array is passed as 3rd arg, Leva may coerce/ignore OR re-register controls on every render (object identity changes per render)

**Common violation:** Passing `{ collapsed: true }` as the 3rd arg of `useControls('PostFx', schema, { collapsed: true })` — interpreted as deps. To collapse the outer folder, there is no option on the top-level call; use per-`folder()` `{collapsed: true}` instead, or no outer wrapper.

**Detection:** Leva panel shows only the root-level knobs (`exposure`) but not folder labels (`SMAA`, `N8AO`, ...). Folders are missing from the rendered UI. In our case it was actually fine; we found this chasing a false alarm — BUT the no-op 3rd arg object was identity-unstable, causing potential re-registration churn.

**Root fix:** Drop the no-op 3rd arg. Per-folder settings go in `folder(schema, { collapsed: true })`:
```tsx
useControls('PostFx', {
  someFolder: folder({ /* ... */ }, { collapsed: true }),
  // NOT useControls('PostFx', {...}, { collapsed: true })
})
```

**REF:** UNGROUNDED — canonical instance `src/world/PostFx.tsx` (outer `useControls` has no 3rd arg).

### PK3: glTF diorama load lifecycle
**Lifecycle:**
1. `loadGlbDiorama(url)` — async — `src/diorama/loadGlbDiorama.ts`
2. `GLTFLoader.loadAsync` resolves — async
3. Zero-mesh defensive guard — sync — bail to null if gltf has no isMesh descendants
4. Traverse + `frustumCulled = false` — sync
5. `dedupeMaterials(gltf.scene)` — sync — collapse identical MSM/MPM refs (~150→~33 on current scene)
6. `AnimationMixer(gltf.scene)` + `.play()` every clip — sync
7. `buildGrass(root, { maskImage: grassRefs.activeMask })` — sync — honours persisted mask
8. `root.add(gltf.scene)` + each meadow mesh — sync; caller adds root to dScene
9. (sphere only) `patchSceneForSphere(root, sphereUniformsRef.current)` — sync — idempotent via `__spherePatched`
10. `grassRefs.reapplyControls?.()` — sync — Leva state restored to new meshes

**Common violation:** Calling `buildGrass(root)` without the `maskImage` option after the user has loaded a painted mask. Fix: read `grassRefs.activeMask` on every rebuild path (loadGlbDiorama + rebuildWithMask both do).

**Detection:** Pre/post swap `grassRefs.maxCount` — should stay equal when a mask is active (mask sampling yields same allowed count if scene geometry is unchanged).

**REF:** UNGROUNDED — `src/diorama/loadGlbDiorama.ts` (path) + `src/diorama/TileGrid.tsx:swapInScene` (caller).

### PK4: Hot-reload diorama swap lifecycle
**Lifecycle:**
1. Blender Live Mode writes `public/diorama.glb` — out of process — `blender-plugin/rubics_world.py:_live_tick`
2. Vite chokidar watcher fires — sync on Node — `vite.config.ts:dioramaHotReload`
3. `server.ws.send({ type: 'custom', event: 'diorama:changed', data: { ts } })` — sync
4. Browser `import.meta.hot.on('diorama:changed', ...)` — async — `src/diorama/TileGrid.tsx`
5. `swapInScene(`${glbPath}?t=${ts}`, 'none')` — async — `?t=` busts the browser glb cache
6. PK3 steps 1–9 run
7. Previous root removed from dScene; geometries + materials disposed — sync
8. New root added; sphere patch re-applied — sync
9. `grassRefs.reapplyControls?.()` — sync

**Common violation:** Skipping step 9 — the new meshes come up at buildGrass's default 50% count / uniform defaults and the user sees their panel state "wiped".

**Detection:** Snapshot `mesh.count` + any non-default uniform before the swap and assert equality after.

**REF:** UNGROUNDED — `vite.config.ts:dioramaHotReload` (server side) + `src/diorama/TileGrid.tsx:swapInScene` (client side).

### PK5: glb load post-processing pipeline (between GLTFLoader and TileGrid)
**Lifecycle:** (runs inside `loadGlbDiorama` and is indirectly re-entered by `rebuildWithMask`)
1. `GLTFLoader.parseAsync` resolves → `gltf.scene` — async — `src/diorama/loadGlbDiorama.ts`
2. Zero-mesh guard: if `meshCount === 0`, return null → caller falls back — sync
3. `gltf.scene.traverse(c => c.frustumCulled = false)` — sync, depends on [1]
4. `dedupeMaterials(gltf.scene)` — sync, shares canonical materials by fingerprint
5. `root.add(gltf.scene)` — sync
6. `weldCubeNetSeams(root)` — sync, snaps near-seam verts + mergeVertices per mesh
7. Find ground by name prefix (`ground`/`terrain`) + `geometry.computeVertexNormals()` — sync, depends on [6]
8. `buildGrass(root, { maskImage: grassRefs.activeMask })` — sync, depends on [7]
9. `for (const m of grass.meshes) root.add(m)` — sync
10. Mixer creation (if `gltf.animations.length`) — sync
11. Return `{ root, update }` to caller (TileGrid) — sync

TileGrid then applies the sphere patch (step 12): `patchSceneForSphere(root, uniforms)` — MUST happen AFTER buildGrass so new grass materials get patched too.

**Common violation:**
- Running weld BEFORE dedupe — the weld sees per-mesh-private materials and can't take advantage of the dedupe's canonical pointers (unlikely to break visuals but wastes work).
- Running `computeVertexNormals` BEFORE weld — weld's mergeVertices runs later and clobbers the freshly-computed normals back to first-seen, undoing the smoothing (step ordering 6-then-7 is load-bearing).
- `buildGrass` before computeVertexNormals — the ground's vertex-colour density layer reads from the same attributes and expects smooth normals on the output meshes; not fatal but produces flat-shaded grass in diagnostic renders.

**Detection:** Console logs appear in this order on load: `[diorama] material dedup:`, `[diorama] seam weld:`, `[diorama] recomputed ground normals on "…"`. Grass refs published on `window.__grass` after step 11. Any reordering surfaces as one of the above violation patterns.

**REF:** UNGROUNDED — canonical instance `src/diorama/loadGlbDiorama.ts` (top-to-bottom of `loadGlbDiorama` + inline console logs).

### Entry Format (with mandatory REF)

```
### [ID]: [System/Component Name]
**Lifecycle:**
1. [Step 1] — sync/async — `file:line`
2. [Step 2] — sync/async — depends on [1]
N. [Your code can safely run here]

**Common violation:** [What people get wrong]
**Detection:** [How to verify ordering is correct]
**REF:** [Ground Truth doc]#[section] — traces this lifecycle with code citations
```

The `**REF:**` field links to the Ground Truth doc that traces this lifecycle end-to-end with `file:line` citations. Every step in the lifecycle should be traceable through: catalogue → Ground Truth → source code.
