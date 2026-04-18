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
