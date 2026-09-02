# 0030 — Three things to build, two units to raise, two orders to give

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12; §6.3 (equipment), §6.7 (air), §6.8 (naval)

## Context

Decision 0029 took the resources from four to one and put the numbers that
matter on the screen. It named what was left: ten equipment types, five
formation templates, eight missions. That is the rest of the same problem —
a player has to learn a vocabulary before they can open a production line.

The player also said what he wanted the sea to feel like: _"vielleicht wie in
hoi4 dass man halt flotten hat und für die mehr schiffe kaufen kann und dann
eine region auswählt in der diese patroullieren"_ — fleets you buy ships for
and give a piece of water to hold. That is one template, one good and one
order, not five, four and four.

## Decision

**Three equipment types**: `infantry`, `aircraft`, `ships`. One kind of thing
per kind of unit. The ten carried one real lesson — a division holds rifles
_and_ guns, and fights at the worse of the two ratios — and that lesson was
about bookkeeping rather than about war; what is left of it is that a
division at half kit fights at half strength.

**`ships` is the merchant marine as well as the navy**, which keeps §6.3's
best idea and sharpens it: sea supply and seaborne trade consume ships, and
raiding sinks them, so the ships that carry your trade are the ships that
guard it and losing a naval war shows up twice in the same number.

**Two formation templates**: a `wing` of aircraft and a `fleet` of ships.
What used to be five rows is now _how many_ of the one thing you put in one
of two, which is the number a player was going to look at anyway. §10
excluded a hull-and-module designer for interacting with nothing else on the
list; five fixed rows had the same problem in smaller print.

**Two missions each.** In the air, `air_superiority` is fighting for the sky
and `ground_support` is everything you do with it once you have it. At sea,
`patrol` is a fleet holding a piece of water — it covers your shipping
crossing it _and_ contests it against anybody else there, which is what a
patrol has always meant and what `sea_control` and `convoy_escort` were
separately — and `raiding` is sinking somebody else's shipping.

**Strategic bombing goes.** It was a third way of saying "hurt them somewhere
else". The sky's economic footprint now runs through the army it is flying
over: `ground_support` weakens divisions, divisions lose equipment, and the
factories make it again. Invariant 6 holds, one step longer.

## Consequences

- `STATE_HASH_VERSION` 7 → 8, `PROTOCOL_VERSION` 19 → 20. A world in flight
  is translated again: every stockpile, every division's and every
  formation's kit is folded ten-into-three, templates and missions are
  renamed, and a production line keeps the efficiency ramp it earned.
  `tests/server/SnapshotMigration.test.ts` proves it.
- The regent gets simpler with the game: two military lines instead of four,
  one yard line instead of four, one wing rule instead of two, one fleet rule
  instead of three. What its temperament changes is now _how many_ and
  _where_, which is what it should always have been.
- Still to come: the building list, the tech list, and the panel count — and
  the drawn patrol region, which is what a `fleet` on `patrol` is waiting for.
