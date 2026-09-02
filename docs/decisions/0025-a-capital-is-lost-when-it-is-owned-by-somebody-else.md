# 0025 — A capital is lost when it is owned by somebody else, not when it is held

- **Status:** Proposed (built 2026-09-02, behaviour on by default; Max decides)
- **Date:** 2026-09-02
- **Phase:** after 12; §6.5's dead-partner rule

## Context

§6.5: an agreement with a nation that "has lost its capital" dissolves at no
trust cost. Phase 7 read that as _holds no capital right now_ — the
controller of every capital province, this tick. Decision 0012 and HANDOVER
both flagged the edge: a capital that changes hands for a single tick
dissolves every agreement its nation has, third parties included, and the
nation that retakes it a tick later has lost its alliances for nothing.

The obvious fix is a grace period, and a grace period is a duration, which is
exactly what invariant 3 keeps out of this system.

Decision 0002 separates two things the game already tracks per province: who
_holds_ it (`provinceController`, the front) and whose it _is_
(`provinceOwner`, the map). Ownership follows control only after the province
has been held for `OCCUPATION_TICKS` — fourteen in-game days — via
`World.settleOccupation`.

## Decision

**"Has lost its capital" reads `provinceOwner`, not `provinceController`.**
`tradeContext` in `systems/trade.ts` builds `hasCapital` from the owners of
the capital provinces. A capital that is merely held by an enemy is not lost;
one whose ownership has moved is.

The grace this buys is not a new timer. It is the occupation rule the game
already has, doing the one thing it was for: saying when a conquest has
become the map rather than the front. A nation that retakes its capital
inside the fortnight loses no agreement; one that does not has lost it by the
same clock that hands the province to its occupier.

## Alternatives rejected

- **A grace period on the dead-partner rule.** A duration, forbidden by
  invariant 3; and a second clock beside the occupation clock, answering the
  same question differently.
- **Leave it.** The rule was written for a nation that has _gone_, not one
  that is fighting for its capital. A front-line capital changing hands is a
  routine event on a map where capitals sit at borders; dissolving alliances
  on it punishes the defender for defending.
- **Read both — lost if held by another _and_ owned by another.** The same as
  ownership alone: ownership never moves without control.

## Consequences

- `tests/server/Trade.test.ts` covers the capital half of the rule for the
  first time: held, retaken, owned.
- A nation whose capital is occupied for a fortnight loses its agreements the
  tick ownership moves, exactly as before — only the fortnight is new.
- Proposal and acceptance with a dead partner are refused through the same
  function (`World.ts`), so they follow.
- If Max rejects this, the change is one word in `tradeContext` and this
  record's status becomes Reverted.
