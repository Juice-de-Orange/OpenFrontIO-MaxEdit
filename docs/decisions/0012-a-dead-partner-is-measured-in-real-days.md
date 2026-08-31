# 0012 — A dead partner is seven real days silent, not fourteen in-game ones

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 7

## Context

`CLAUDE.md` §6.5 ends its diplomacy section with a rule that keeps a season
tidy:

> **Dead-partner rule**: an agreement with a nation that has lost its capital
> or has had no player login for 14 in-game days dissolves automatically at no
> trust cost.

Implemented literally, "14 in-game days" is 336 ticks. §4 fixes one tick at
five seconds and one in-game day at 24 ticks — two minutes of wall clock. So
the literal rule dissolves a player's agreements after **twenty-eight real
minutes** of not clicking anything.

That is not what the sentence means. It sits beside "an offline player can be
cut off with no warning" and "indefinite agreements accumulate as dead weight
across a six-week season": it is about a nation nobody is playing any more,
not about a player who went to lunch. The in-game unit was chosen because
every other duration in the design is in in-game time, and in-game time in
this world runs a hundred and eighty times faster than the wall clock.

## Decision

**Seven days of wall clock**, derived from `TICK_MS` so it stays seven days if
the tick rate is retuned:

```ts
const SILENT_REAL_DAYS = 7;
export const DEAD_PARTNER_TICKS = Math.round(
  (SILENT_REAL_DAYS * 24 * 60 * 60 * 1000) / TICK_MS,
);
```

120,960 ticks, which is 5,040 in-game days — a number that is meaningless in
in-game terms and exactly right in the terms the rule is actually about.
A six-week season therefore writes off a nation after about a sixth of it,
which leaves a returning player their agreements and still clears the board of
nations that were abandoned early.

Derived from `TICK_MS`, the nominal rate, and **not** from the `WORLD_TICK_MS`
override a gate runs under. A world at fifty milliseconds a tick is the same
world sooner, not a different one, and the schedule is anchored to the tick
(decision 0003). A gate that wanted to watch this rule fire would set the
nation's `lastSeenTick` rather than wait.

## Consequences

- The rule is no longer observable in a gate run: 120,960 ticks at fifty
  milliseconds is an hour and forty minutes. It is unit-tested instead, in
  `tests/server/Trade.test.ts`, by moving the world's tick forward.
- **An offer to a nation nobody has ever played is now accepted.** Validation
  refuses an offer to a _dead_ partner, and on a young world nobody is dead
  yet, so a proposal to an unplayed nation is legal and simply sits there
  unanswered — which is the honest outcome, since there is nobody to answer
  it. The regent never accepts an agreement (invariant 7), so it stays a
  proposal for the life of the season or until the proposer withdraws it.
- The other half of the rule — "has lost its capital" — is unchanged and is
  still read as _holds no capital right now_. That edge is sharper than this
  one and is deliberately left open: a grace period would be a duration, and
  keeping durations out is what invariant 3 is for. Phase 9, where a landing
  can take a capital, is when it has to be decided.
- This is the second place the code departs from a literal reading of
  `CLAUDE.md` §6.5 in phase 7. The first is in decision 0011: §6.5's "attacking
  a nation you hold a non_aggression with costs almost all of it" is charged
  when the pact is cancelled, because §6.9 refuses the attack itself.
