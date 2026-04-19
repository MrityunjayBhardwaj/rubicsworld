# Todos — RubicsWorld

## ONBOARDING_TUTORIAL — replace attract intro with guided 3-move tutorial
**Captured:** 2026-04-19 (Day 10 session)
**Status:** planned, not started

**Intent:**
- Camera orbits solved planet for a few seconds (current intro behaviour)
- Scramble with just **3** rotations (not 18) — gentle enough to teach
- Lottie hand/swipe overlay hovers near the target tile urging the swipe direction
- User swipes → overlay advances to the next required move
- Continue guiding until the planet is back to solved
- One-time onboarding — gate on `localStorage.rubicsworld:tutorialSeen`; subsequent visits fall back to the current 18-move attract intro

**Why:** current intro demonstrates atmosphere but doesn't teach mechanics. New players land on a scrambled planet with no affordance for how to interact. A 3-move guided loop converts the attract sequence into a playable tutorial in the same screen-time budget.

**Success criteria:**
- First visit: scramble(3) → tutorial overlay guides user through 3 correct commits → `planet:settled` fires → overlay dismisses → flag written
- Repeat visit: current attract intro plays (scramble 18, no overlay)
- Skip path: Esc or dev Leva button bypasses tutorial + sets flag
- Works via drag AND keyboard rotation paths (both funnel through `applyRotation`)
- No regressions to walk-mode entry, HDRI panel, or bezier editor interactivity
