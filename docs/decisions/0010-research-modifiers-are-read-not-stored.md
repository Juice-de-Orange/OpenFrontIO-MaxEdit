# 0010 — Research modifiers are read where the rate is read, never stored

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 5

## Context

`CLAUDE.md` §6.4 asks for a flat tech list granting "flat modifiers
(production efficiency cap, supply range, combat stats, refinery ratio, convoy
capacity)". It does not say where those modifiers live once a tech is unlocked,
and there are two obvious answers.

## Decision

**A nation stores only which techs it has finished.** Every rate is computed
from that list at the moment it is read, through three helpers in
`WorldState.ts`: `nationModifiers`, `factoryOutput` and `efficiencyCapFor`.

The alternative — folding the modifiers once when a tech completes and keeping
the result on the nation — is faster and wrong in a way this project has
already paid for once.

A stored fold is a second source of truth. It has to be in the snapshot, it
has to be in the state hash, and it has to be recomputed correctly on every
restore, on every replayed command, and on the day somebody retunes a number
in `techs.ts` while a season is running. Get any of those wrong and a world
comes back with a stale copy of its own bonuses — which is precisely the class
of failure the phase-1 restore gate exists to catch, and precisely the class
it would be unable to see, because the stale value would hash consistently
with itself.

The fold is a handful of additions over a list that is never longer than the
tech tree. It is not worth a bug.

## And modifiers add rather than compound

Two +10% techs are +20%, not +21%. Compounding is the more realistic rule and
the less readable one: a player should be able to add the numbers on the screen
and get the number on the screen. Invariant 9 is about one number vocabulary,
and a vocabulary in which 10 and 10 make 21 is a vocabulary nobody trusts.

## Consequences

- Every system that reads a rate reads it through a helper, so a tech takes
  effect everywhere or nowhere. `production.ts` no longer imports
  `MILITARY_FACTORY_OUTPUT` at all.
- **The reducer's efficiency clamp had to change too.** It trimmed to the
  constant `EFFICIENCY_CAP`, so a tech that raised the cap would have been
  thrown away by the reducer on the very tick the line reached the old one —
  and the symptom would have been "the tech does nothing", which is
  indistinguishable from the tech being broken.
- A snapshot written before phase 5 has no research in it. `restoreFrom`
  treats both fields as optional and fills in empty slots: a season already in
  progress is not something to end over a field that did not exist when it was
  written.
- The tech list is deliberately short and every entry moves a number that
  already exists. A tech granting "+10% supply range" before phase 6 has built
  supply would do nothing, and doing nothing is indistinguishable from a bug.
