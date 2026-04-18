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
