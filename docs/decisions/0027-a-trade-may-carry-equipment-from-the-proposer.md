# 0027 — A trade may carry equipment from the proposer, priced like the resource

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12; §6.5 (trade), §10 (the sixth open question)

## Context

§10 decided that trade agreements may carry equipment as well as resources:
it lets allies specialise — one builds armour, another aircraft — and uses the
trade system already built. The decision was written down; the mechanism was
not. Until now `TradeTerms` named one resource, one rate and one price, and
the sea priced a route's convoys off the resource rate in two places that
had already disagreed once (the phase-9 gate found trade and naval pricing
the same crossing differently).

## Decision

**Terms carry an optional `equipment: { type, perTick }`**, sent by the
proposer (`parties[0]`) beside the resource, and paid for by the same
construction points. A trade may carry a resource, equipment, or both: the
resource rate may be zero only when equipment rides. Absent rather than null,
so a snapshot written before this decision reads back unchanged.

**One exchange, one scale.** The seller's shortfall in either good scales
the whole trade down together (invariant 2): a partner short of fighters
sends less steel too, rather than being paid in full for half a delivery.
The buyer's shelf room is checked for both, against `EQUIPMENT_CAP` for the
crates.

**The whole rate is what the sea sees.** `tradeFlowRate(terms)` in
`shared/economy/Trade.ts` is resource plus equipment per tick, and it is the
one function the trade system, the naval system and the regent's escort duty
price convoys from. Crates ride convoys like everything else, and raiders sink
them the same way (invariant 6).

**Its own, lower ceiling.** `MAX_TRADE_EQUIPMENT_PER_TICK = 2` beside the
resource's 5: a military factory makes a fraction of a unit a tick, so two a
tick is already a partner's whole arms industry. What keeps buying from
replacing building is the efficiency ramp (§6.2): the points spent on arms
are points that did not build factories, and a nation that buys everything
never climbs a ramp.

**One lane per goods.** The duplicate rule keys on resource _and_ equipment
type: rifles for steel twice is a duplicate, rifles beside a plain steel
trade is a second lane.

## Consequences

- `STATE_HASH_VERSION` 5 → 6 (the hash mixes the equipment type and rate);
  `PROTOCOL_VERSION` 17 → 18 with decision 0028. A running world restores
  loudly and continues (decision 0016).
- The diplomacy form offers a resource or a piece of equipment; the terms
  line reads "12 fighters for 6 construction" or "12 steel and 12 fighters
  for 6 construction".
- The regent proposes nothing (invariant 7): equipment trade is a thing
  players do with each other.
- The economy view carries no separate equipment-flow figure yet; the
  stockpile moving is the visible trace. A `tradeEquipmentPerTick` beside
  `tradeResourcePerTick` is the obvious next step if players ask where their
  fighters went.
