# 0015 — One formation, one zone machine, and a table instead of a branch

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 8

## Context

§6.7 asks for air zones: wings assigned from an air base to a zone plus a
mission, resolved every tick into a superiority ratio that modifies ground
combat, supply throughput and factory output. §6.8 then asks for sea zones —
and says outright that they are **the same code with a different mission set**.
Invariant 5 says it from the other side: one zone abstraction, and any third
zoned system reuses it again.

That is unusually specific for a design document, and it is specific because
the obvious way to build phase 8 is to write an air system, and then to write
a naval system beside it in phase 9 that looks almost the same. The handover
had already put the warning in the imperative: _if you find yourself writing a
second one later, the mistake was made here._

The pull toward two systems is real. A fighter wing and a submarine flotilla
have nothing in common at the level of what they _do_: one fights for the sky
over a province, the other sinks convoys carrying supply across a sea. It is
easy to conclude that the shared part is too thin to be worth abstracting.

## Decision

**One entity, one resolver, and everything that differs is data.**

A `Formation` is whatever a player assigns to a zone — a wing today, a fleet in
phase 9. It follows `Division` exactly: an id the reducer hands out, a base
province, held equipment drawn from the same national stockpile, and a strength
that is the worst ratio against its own template.

```ts
interface Formation {
  id: number;
  template: FormationTemplate; // fighter_wing, bomber_wing, …
  base: ProvinceId;
  zone: ZoneId | null; // null together with mission: standing down
  mission: Mission | null;
  equipment: number[];
}
```

`shared/economy/Formations.ts` holds the table. Each template names the zone
kind it serves, the base it needs, what it is at full strength, and **what it
is worth on every mission**:

```ts
fighter_wing: {
  kind: "air", base: "air_base", equipment: { fighter: 24 },
  weight: { air_superiority: 1, ground_support: 0.35, … },
}
```

`server/systems/zones.ts` reads that table and knows nothing about aircraft. It
can find the zone a province belongs to, derive zone adjacency from the
province graph, resolve a contest, clamp a superiority ratio and saturate a
mission's power. `systems/air.ts` is the thin half that knows the contest is
fought by aircraft: it charges attrition and sends home formations whose base
was lost.

**Phase 9 adds rows, not branches.** A submarine flotilla is
`{ kind: "naval", base: "naval_base", equipment: { submarine: 8 },
weight: { convoy_raiding: 1, sea_control: 0.2, … } }`. The naval missions are
already in the file, and `MISSIONS_BY_KIND` already offers them.

## Why the weight table, specifically

It is the piece that makes one resolver possible, and it was chosen because
§6.8 describes naval combat entirely in those terms: _submarines are strong at
convoy raiding and weak in a stand-up fight; escorts counter them; capital
ships decide sea control._ That is a table of numbers per (template, mission),
not a set of rules. Writing it as a table means phase 9's combat behaviour is
balance data rather than code, which is also where CLAUDE.md §9 wants every
balance number to live.

A zero in that table is a **shape** rule — a fleet cannot fly ground support —
and never a shortage rule. Nothing in it is allowed to express "this is too
weak to work", because that is invariant 2's job and invariant 2 says degrade.
A bomber sent to fight for the sky contributes at a fifth, not at nothing.

## The alternative, and why not

Write `air.ts` now with wings hard-coded, and generalise in phase 9 when the
second case makes the shared shape obvious.

This is the standard advice and it is usually right. It was rejected here for
one reason: **the second case is already fully specified.** §6.8 lists the four
naval missions, the three ship types and how they beat each other. Waiting for
the requirement to arrive is a good rule when the requirement is unknown; it is
just delay when it is written down in the same document.

The cost of being wrong is also asymmetric. If the abstraction turns out to fit
badly, phase 9 edits one table and one resolver. If phase 8 hard-codes wings,
phase 9 either duplicates several hundred lines or rewrites a system that by
then has a passing gate attached to it.

## Consequences

- **`fighter` and `bomber` stopped being decorative.** Both had been
  produceable since phase 4 and consumed by nothing at all — a nation could
  fill a warehouse with aircraft that did not exist as far as the rest of the
  game was concerned. Formations are what draws them.
- **Reinforcement serves both kinds in one pass** over one copy of the
  stockpile (`systems/production.ts`). Two passes would let divisions empty it
  before wings were asked; invisible today, because no two templates share an
  equipment type, and a bug nobody could see coming the day two do.
- **The three effects live where they land, not here.** `ground_support` is a
  multiplier beside the roll in `combat.ts`, `interdiction` scales reach inside
  `supplyReach`, `strategic_bombing` scales factory output in `economy.ts`.
  Each reads the ratio through `zones.ts` at the moment it needs it, which
  keeps the coupling one-directional and means the air system stores nothing.
- **`ZONE_REACH` gives an air base a location that matters.** A formation may
  fly to its base's zone and to any zone bordering it, with adjacency derived
  from the province graph. Unlimited range would make where a player builds a
  base a formality, and invariant 8 — the province is the unit of interaction —
  decoration.
- **The state hash gained the formations**, so every world in progress has to
  be started fresh. There is no migration path and there is not meant to be
  one.
- Wire went 10 → 11: the economy view carries `formations` and `zones`, and
  three commands joined the union.
