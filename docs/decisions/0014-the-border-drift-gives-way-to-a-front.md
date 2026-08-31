# 0014 — The border drift gives way to a front, and an unattended world is quiet

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 8

## Context

From phase 1 to phase 7 `systems/combat.ts` was a deterministic sweep: one
province changed hands every tick, picked by walking the province list with a
stride, regardless of who held what or whether anybody was standing there.
Phase 4 gave it a cost — the divisions on both sides of the flip lost equipment
— and the file said plainly that §6.9's real resolution was deferred.

It was there for two reasons, both good at the time. A persistent world with
nobody online still had to look alive, and the replay test needed something
hard to reproduce.

Phase 8 needs air superiority to "measurably shift a ground battle" (§8), and
there was no ground battle to shift: the sweep has no strength inputs at all.
So §6.9 had to be built, and that raised the question of what happens to the
sweep.

## Decision

**The drift is gone, and nothing takes a province unless somebody orders it.**

`claim_province` is now a _standing attack order_ rather than an event. It goes
onto the nation's `attacks` list and stays there; every tick the combat system
resolves it again against whatever is holding the place, and it grinds until
the province falls, the player withdraws it (`cancel_attack`), or the province
becomes theirs some other way. That is what §6.9 means by front-based rather
than unit-based: an attack is a posture, not a click.

The resolution takes §6.9's own inputs — equipment through `divisionStrength`,
supply, terrain, and `COMBAT_WIDTH` bounding how much force can meet at one
border — and a roll seeded from `(worldSeed, tick, province)`.

**Ground nobody is holding is walked into.** A province with no division in it
is not a battle: the order takes it on the tick it applies, exactly as
`claim_province` always did. That is not a concession to the early gates,
though it does keep their instrument working — it is what taking empty ground
is.

**Signing peace calls off an attack that is already grinding.** §6.9 refuses a
_new_ attack on a nation you hold a non-aggression pact or an alliance with;
without this, an order given before the pact would go on taking provinces
after it, and the promise would be worth nothing in the one place it matters.

## The alternative, and why not

Keeping the drift for borders where neither side has a division was the cheaper
option and it would have kept every gate green. It was rejected because it
means **two ways to take a province, and the cheaper one ignores terrain,
supply, combat width and the roll**. A rule that applies only when nobody is
looking is the kind of thing that survives three phases and then decides a
season.

The consequence is accepted rather than worked around: **between here and phase
10 an unattended world is quiet.** That is honest — there is nobody there to
attack — and it is exactly the hole the regent is for (§6.10). It also removes
a great deal of noise the gates were fighting: phase 3 lost mines and stalled
builds to the drift, phase 5 measured production while it took factories away,
and the whole shelter mechanism in phase 6 exists to hide from it.

## And the world gained a seed

§9 asks for randomness derived from `(worldSeed, tick, contextId)` and there
was no world seed: the state carried only the map's hashes. Using those would
have made every season on Europe fight the same war, tick for tick, which is a
thing somebody notices in week two. `worldSeed` is derived from the world's
name when it is created, and is in the snapshot and the state hash like
everything else.

## Consequences

- **The state hash changed twice over** (the seed, and the standing orders), so
  a world from before this build cannot be resumed. Started fresh, as
  `WorldRunner.restore` now says in as many words.
- `tests/server/Combat.test.ts` covers the resolver: walk-in, grind, cost to
  both sides, combat width, and the two halves of determinism — the same seed
  fights the same war, a different seed does not.
- **The phase-4 gate is red until it is rewritten**, and it is the only one.
  Its first half — "a sustained fight visibly drains a stockpile" — used the
  drift _as_ the fight: it raised divisions on a border and waited for the
  sweep to hit them. It now needs to start a war, which means connecting as two
  nations, garrisoning one province and attacking it from the other. That is a
  better gate than the one it replaces, and it is written down here because a
  red gate with a plan is worth more than a green one that measured a
  placeholder.
- Nothing else in the phase list changes. Air superiority arrives in phase 8 as
  one more multiplier on a resolution that now exists.
