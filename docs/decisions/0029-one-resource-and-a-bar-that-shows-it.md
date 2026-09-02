# 0029 — One resource, and a bar that always shows it

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12; §5 (resources), §6.1 (refineries), §9 (the UI vocabulary)

## Context

The player's words, after a day of building: _"das game ist viel zu
kompliziert, kannst du es ca 70% simpler machen. und ich habe keine ahnung
welche ressourcen man hat."_

Both halves were fair, and the second one is a bug rather than a taste. What
a player had in front of them: six panels, twenty-two commands, four
resources, ten equipment types, ten buildings, ten techs, eight missions.
Hearts of Iron's surface without its tutorial. And the four stockpiles lived
inside the economy panel, one of the six, so a player who had not opened that
panel did not know what they owned.

## Decision

**One resource, `material`.** §5's four — steel, oil, aluminium, rubber —
were a lopsided table so that every nation was short of _something_ and had a
reason to trade. That reason survives, because deposits are still lopsided:
what changed is that the lopsidedness is now _how much_ rather than _which_,
and the upper quartile of nations digs more than twice what the lower one
does. What did not survive is the bookkeeping — four stockpiles, four
extraction rates, four demand rates, four market prices and four rows in
every panel, to support one decision that was never about which of them you
were short of.

**The synthetic refineries go with it.** §6.1 gave them one job: convert the
resource you have into the resource you lack, for a nation with nobody to
trade with. With one resource there is nothing to convert into anything. The
answer to a shortage is now the world market alone, which is where §6.5 put
it anyway, and it is one building type fewer to explain.

**The market can no longer swap one good for another.** A market order buys
material or sells it. Turning goods into the currency and the currency back
into goods still works, and that is what keeps a nation with no factories
playable (invariant 2) — but "sell steel to buy oil" is gone, because there
is no oil.

**Three numbers are on the screen at all times**: material, construction and
manpower, in the menu bar, each with the direction it is moving. A number a
player has to go and look for is a number they do not have. Three and no
more: a bar with six would be the panel it replaced.

**The map artefacts are regenerated, not migrated.** The generator now rolls
one deposit; `provinces.bin` and both hashes come out byte-identical, so
province ids do not move and a running season does not end. The decoder also
sums any four-resource deposits it is handed, so an artefact from before this
decision still loads.

## Consequences

- `STATE_HASH_VERSION` 6 → 7 and `PROTOCOL_VERSION` 18 → 19. A running world
  is **translated on restore**, not refused: the four stockpiles are added
  up and clamped, and every province's building row is re-indexed around the
  two holes the refineries left — without which every air base would silently
  become a supply hub. `tests/server/SnapshotMigration.test.ts` is the proof.
- The regent's refinery rule is gone; its market rule is now the whole of its
  one economic reaction (§6.10).
- This is the first of the simplification steps, not all of it. Equipment
  (ten types), buildings (eight), techs (ten) and missions (eight) are still
  to come, along with the panels.
