# 0023 — A battle is reported to both its parties, and a nation has a face

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12 (playability), HANDOVER "The next plan" step 4

## Context

The player opened the deployed world and could not read it. Among the things
he asked for: "ground war has to be visibly simulated, and I want numbers like
in the real game", and "give the countries more personality".

`combat.ts` computes, every tick and for every standing front, both sides'
engaged strength, the terrain and air modifiers, the advance and the losses —
and keeps only `progress`. Everything else was thrown away at the end of the
tick. The wire carried the front (public, so the map can paint it) and nothing
about the fight.

The wire's own rule, written on `ZoneSchema` in phase 8, is that what the
other side has _assigned_ is not on the wire: that is the intelligence a
player would have to fly a mission to learn. Putting the defender's strength
in front of the attacker is a departure from that rule, and an undocumented
departure gets reverted in three months by somebody reading the old comment.

Separately, fifty-one of fifty-two nations are played by their regent for most
of a season. They had a name and a flag in the manifest — the flag was dropped
at load since phase 0 — and nobody at the top.

Both changes touch the wire, so they ride one protocol bump (16 → 17), because
a bump disconnects every live client and should happen once.

## Decision

**A battle is reported to both nations in it, per tick, as a transient
event.** `combat.ts` emits `battle_resolved` beside the equipment and progress
events it already emits. The reducer's case for it is a no-op: it changes no
state, so it is in no snapshot and no hash, and `STATE_HASH_VERSION` stays 5.
The socket layer filters it per session — attacker and defender each get the
report on their delta as `battles`, a spectator gets none. The report carries
both strengths, both modifiers as signed values, the advance and both losses,
per tick like every rate on the wire; the HUD shows them per day.

**The exception to "assignments are not on the wire" is exactly this: a
nation standing in a fight knows what it is fighting.** It learns the enemy's
engaged strength at that border and nothing else — not what is behind it, not
what is assigned to the zone above it, not what stands in the next province.
That is what a commander at a front knows.

**A ruler is derived, never stored.** `rulerName(worldSeed, smallID)` is a
pure function in `shared/config/rulers.ts`, drawn from two pan-European lists
that are deliberately not matched to a nation. The world fills it in when it
builds its nation list from the manifest on every start, so every start names
the same people. The manifest's `flag` is passed through beside it.

## Alternatives rejected

- **Store the battle numbers in `WorldState` so the full state carries them.**
  Every stored field goes into the snapshot and the hash; the hash version
  would move and the running season would end (decision 0016 makes that
  survivable, not free). A report that is a tick old is worth nothing to a
  fresh client anyway — the next delta brings the next one.
- **Show each side only its own numbers.** Consistent with the zone rule, and
  useless: "your strength 2.4, advance +3%/day" tells the player nothing about
  _why_. The comparison is the information.
- **Store the ruler's name on the nation, chosen at season opening.** One line
  in the snapshot and a hash bump for a cosmetic. The derivation costs nothing
  and reproduces exactly.
- **Nation-matched name lists.** Fifty-two lists to write and to get wrong, and
  a "typical" name for a country is a stereotype for its neighbour.

## Consequences

- Protocol 17. The twelve gate scripts and `tests/shared/Wire.test.ts` pin it.
- `Delta.battles`, `NationStatic.ruler`, `NationStatic.flag?` and
  `NationEconomy.civilianFactories` are on the wire. Nothing on the full state
  changed shape except `nations`.
- The player's own name is a separate question (decision 0019 draws the line:
  names never reach a snapshot or the command log) and is not answered here.
  The HUD shows the player's own nation by name alone.
- A third exception to the assignment rule would want a record of its own.
  Two are a pattern; this one is written down so the next is compared to it.
