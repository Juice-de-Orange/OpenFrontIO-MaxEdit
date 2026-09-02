# 0026 — Trust may regrow, at a rate that is a constant and defaults to none

- **Status:** Proposed (built 2026-09-02, switched off by default; Max decides)
- **Date:** 2026-09-02
- **Phase:** after 12; §6.5's trust

## Context

§6.5 says what cancelling an agreement costs in trust and nothing about
recovery, so since phase 7 nothing recovers it. A nation that breaks a
non-aggression pact spends 75 of its 100 and is diplomatically poor for the
rest of a six-week season. HANDOVER has carried the question since: that may
be exactly what "serial betrayers become diplomatically isolated" means, or it
may make the first betrayal the last interesting decision a nation makes.

## Decision

**A constant, `TRUST_REGROWTH_PER_DAY` in `shared/config/diplomacy.ts`, and it
is zero.** When it is above zero the trade system — the per-tick diplomacy
pass — emits a `trust_changed` for every nation below `TRUST_MAX`, a day's
worth spread over the day; the reducer already clamps at the ceiling. At zero
it emits nothing, so a world on the default is the world phase 7 gated, event
for event.

Max decides the value. One is the number to try: a broken pact takes 75
in-game days, two and a half real weeks, to live down — long enough that a
betrayal shapes most of a season, short enough that a nation can climb back
before it ends.

## Alternatives rejected

- **No regrowth, ever, and close the question.** Defensible from the text,
  but it is a design choice the spec did not make, and a constant at zero costs
  nothing and leaves the choice where it belongs.
- **Regrowth as a regent behaviour.** Invariant 7: the regent never touches
  obligations, and trust is the price of them. Regrowth is the world's clock,
  not a steward's decision — `tests/server/Regent.test.ts` asserts the regent
  emits no `trust_changed`, and that stays true.
- **Regrowth scaled by behaviour** (faster while holding agreements, slower
  after a betrayal). A mechanic §6.5 does not ask for, needing state the
  snapshot does not have. The constant can grow into it if the plain rate turns
  out wrong.

## Consequences

- Trust is already in the state hash and on the wire; nothing structural
  changes. With the constant above zero every tick moves every nation's trust,
  so the hash value differs from a run without it — a change of the constant is
  a season boundary in the sense of decision 0016, not a hot swap.
- `help.diplomacy.trust` says "It never comes back." That stays true at the
  default; if Max sets a rate, the sentence changes with it.
- `trustRegrowth(state, perDay)` is exported for the test, which runs it at 0
  and at 1.
