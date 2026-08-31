# 0009 — A factory is fed by what it makes, and an idle one still eats

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 4

## Context

Phase 3 gave every military factory and dockyard a flat per-tick resource
draw: `MILITARY_FACTORY_DEMAND` and `DOCKYARD_DEMAND`. It did not matter what
the factory was making, because in phase 3 a factory did not make anything —
it produced an abstract "industrial output" that the economy screen showed.

Phase 4 gave those factories production lines, and with them a choice: this
line makes rifles, that one makes tanks. Under the flat draw the choice had no
economic consequence at all. A tank costs twelve times what a rifle costs in
_industrial output_ (`EQUIPMENT[type].cost`), so it comes off the line twelve
times slower — but it drew exactly the same steel per tick, and no rubber and
no oil, ever.

That fails invariant 6 from the other end: an armaments decision with no
footprint in the economy screen.

## Decision

A factory **on a production line** draws `EQUIPMENT_MATERIALS[equipment]` per
tick. A factory **not on a line** keeps drawing the flat rate.

Three things follow, and each was the point of a rejected alternative.

### The recipe hangs off the line, not off the building

Production lines are national: a line is a *number* of factories, not a set of
buildings in named provinces. So the split between "assigned" and "idle" is
computed once per nation, against the totals the province scan already
counted, rather than per province. A per-province recipe would have needed
factories to be individually addressable, which is a much larger change and
one invariant 4 argues against — the player allocates, they do not
micromanage which building in which province makes what.

### The recipe is not scaled by `cost`

`EQUIPMENT_MATERIALS` is read per factory per tick, exactly like the flat rate
it replaces. It is tempting to multiply by the equipment's industrial cost as
well, on the grounds that a tank is a bigger object. That would be counting
the same fact twice: a heavy type is *already* slow to come off the line,
because `cost` divides its output. Multiplying as well would make an armour
line fifty times the drain of a rifle line rather than three times it, and
nothing but infantry would ever be affordable.

### An idle factory is not free

The cheapest line — infantry equipment — draws about what the flat rate draws.
Everything else draws more. An unassigned factory therefore costs what the
cheapest line costs: a plant kept tooled and staffed, ready to be given a job.

The alternative, an idle factory drawing nothing, was rejected twice over.

It is wrong as a game rule: a nation could park its entire industry between
wars at no cost, and the shortage mechanic — the thing invariant 2 exists to
demonstrate — would only ever engage for a nation that was actually building
something. Mothballing would be strictly correct play, and strictly boring.

And it is wrong as a change: **the phase-3 gate builds nothing but unassigned
military factories**, and measures the flat draw outgrowing the nation's mines
until sufficiency falls below one. An idle factory that drew nothing would
have made that gate unfalsifiable — a passed gate broken by a later phase, for
a reason with nothing to do with what it was testing.

## Consequences

- `measureNation` in `src/server/systems/economy.ts` now reads the nation's
  production lines. It was already the only place demand is computed, and it
  is still pure.
- Retooling a line changes what the nation consumes as well as what it
  produces. Switching to armour raises the steel bill on the tick the switch
  lands, while the efficiency reset means less comes out for a fortnight —
  the switch is expensive from both directions now, which is the intent of
  §6.2.
- A nation can be pushed into shortage by a switch alone, with no new
  buildings. That is degradation, not a block (invariant 2): the line runs at
  the covered share, like everything else.
- The table is a first cut and is expected to be retuned. It lives in
  `shared/config/rates.ts` with every other balance number, per §9.
