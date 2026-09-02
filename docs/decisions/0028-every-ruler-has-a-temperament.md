# 0028 — Every ruler has a temperament, and the regent plays it

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12; §6.10 (the regent), decided with Max

## Context

Decision 0023 gave every nation a ruler's name derived from the world seed.
The regent behind the name was one steward in fifty-one colours: the same
rules, the same first building, the same tech, and — because the deployed
season opened before the seed-drawn focus existed — the same focus. §6.10
allows the focus to change allocation weights and nothing else, and four
foci are not fifty-one characters.

The player asked for rulers who are each a little different and set different
priorities, and for a regent that uses the whole system: air, sea, convoys,
refineries, borders. A regent that plays every system the same way for every
nation would still be one opponent.

## Decision

**A temperament per ruler, derived, never stored.** `temperamentOf(worldSeed,
nation, coastal)` in `shared/config/temperament.ts` draws six axes —
aggression, caution, industry, naval, air, science — each between 0.2 and 1,
lifts the highest to at least 0.85 so the tendency is legible, and names the
archetype from it: builder, warden, admiral, airman, scholar, conqueror; or
marshal when aggression and caution are both high. A nation cut from the map
without a coast has its naval axis floored before the draw decides, so no
landlocked admirals. Like the name, it lives in no snapshot and moves no hash.

**The archetype is public.** It rides on `NationStatic` beside the ruler and
the diplomacy panel reads "Otherland · Alma Falk, the conqueror". Max's call:
a conqueror known as one makes diplomacy a game, and a temperament nobody can
read is worth nothing.

**The season's opening hands an unclaimed nation the focus its archetype
calls for** — conqueror → expansion, warden → defence, marshal, airman and
admiral → military, builder and scholar → economy — instead of a plain draw.
A player's focus is the player's (invariant 7 keeps the world out of a held
nation's regent).

**The regent reads the axes**, not the archetype: garrison strength from
caution, fronts from aggression, fleets from naval, wings from air, tech order
from science, factories from industry. The focus stays what §6.10 says it is,
the coarse allocation; the axes are the weights under it.

**One deviation from §6.10, decided by Max:** "expansion" attacks, and **a
marshal attacks under the military focus too**, one front at a time.
"defence" and "economy" never attack.

## Alternatives rejected

- **Stored personalities**, chosen at the season's opening. A snapshot field
  and a hash bump for a cosmetic — the derivation reproduces exactly.
- **Archetype from the nation's name or history.** Fifty-two hand-written
  characters is a content project, and a stereotype for each neighbour.
- **Hidden temperament.** Observable within an hour anyway from what the
  nation builds; hiding it only costs the player the diplomacy the fact
  would have started.
- **Temperament overriding the focus.** The focus is the one lever a player
  has over their own regent; the axes shape how it is pursued, never whether.

## Consequences

- Protocol 18 (bundled with the equipment trade, decision 0027).
- `REGENT_FOCUS_RESEED` now re-seeds the deployed season's regents onto the
  archetype's focus rather than a random one.
- The regent's second pass (`systems/regent/`) is where the axes take
  effect; this record is its design brief.
