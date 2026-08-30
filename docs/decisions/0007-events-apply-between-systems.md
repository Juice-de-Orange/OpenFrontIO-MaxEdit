# 0007 — A system's events are applied before the next system runs

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 3

## Context

`CLAUDE.md` §6 says two things that cannot both be read literally:

> Events are the only mutation mechanism, applied by the world reducer **after
> all systems have run**.

and, justifying the fixed order a few lines later:

> Trade runs before supply because **imported resources must be available
> before** supply consumption is computed.
>
> Supply computes demand, naval destroys the convoys carrying it, and the
> shortfall lands on the following tick.

If every event were held until the end of the tick, running trade before supply
would change nothing: supply would see the stockpile as it was at the start of
the tick either way, and the whole rationale for the order — which the same
section calls out as encoding "real dependencies" — would be decoration. The
one place the specification _does_ want a system not to see an earlier one is
the supply/naval pair, and it describes that as a deliberate **one-tick lag**,
which is a statement about those two systems rather than about all eleven.

Phase 3 is the first phase with two systems that interact, so this is the first
point at which the reading matters.

## Decision

The reducer applies each system's events immediately after that system returns,
before the next system runs.

Events remain the only mutation mechanism: no system assigns to world state,
and the tick's full event list is still produced in order and available as the
tick's record. What changes is only _when_ the reducer runs — eleven times a
tick rather than once.

The supply/naval one-tick lag is preserved by the order itself, exactly as §6
describes: naval runs after supply, so the convoys it sinks are subtracted from
a demand supply has already computed, and the shortfall lands on the next tick.
That lag is a consequence of the ordering, not of batching the reducer.

## Alternatives rejected

- **Apply everything at the end of the tick, as written.** Makes the system
  order meaningless for every pair except through explicit staging, and would
  require phase 3's construction system to be handed the economy's output
  through a side channel that is not the event log.
- **Let systems read a "pending events" list.** Every system would then have to
  reimplement the reducer to know what the world will look like, and each
  reimplementation is a chance to disagree with the real one.
- **Let systems write to world state directly, keeping events as a log.** The
  log would then be a description of what happened rather than the mechanism,
  and a replay would depend on the systems rather than on the reducer. That is
  the property the whole persistence design rests on.

## Consequences

- A system may rely on everything earlier in the order having taken effect.
  That is now a real guarantee and the order is load-bearing; moving a system
  in the list is a semantic change.
- A system may **not** rely on anything later in the order. The supply/naval
  lag is the documented case, and §6 already warns not to "fix" it.
- The tick is still reproducible from the log: the reducer is deterministic,
  the order is fixed, and no system reads anything outside world state.
