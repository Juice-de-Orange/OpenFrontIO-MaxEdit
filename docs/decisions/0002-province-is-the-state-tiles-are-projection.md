# 0002 — Province ownership is the state; tiles are projected from it

- **Status:** Accepted
- **Date:** 2026-08-30
- **Phase:** 2

## Context

`CLAUDE.md` section 5 says "ownership of a province derives from the majority
owner of its tiles". Read literally, tiles are the truth and provinces are
computed from them. On the Europe map that means the authoritative state holds
**4.86 million tile owners**, every ownership delta carries a tile list, and
there is no good answer to "who is allowed to write a tile?" — which collides
with invariant 8, _tiles exist for rendering only and are never addressable by a
player action_.

## Decision

Invert it. `provinceOwner` and `provinceController` are the state — roughly 800
numbers. The tiles of a province are painted from that, uniformly, using the
run-length spans built when the province map loads.

The specification's majority rule survives as a **checked invariant** rather than
a computation: every invariant test asserts that the tile majority of each
province equals its recorded owner.

Ownership is split in two, which the specification's `Province` interface already
anticipated:

- `controller` changes **immediately** when an attacker holds the province —
  fast, visible feedback.
- `owner` changes only once the same controller has held it for a configured
  duration (order of one to two in-game weeks). Until then it is occupied
  territory: reduced output, no victory credit, and instant reversion if retaken.

## Alternatives rejected

- **Tiles as the truth, as written.** Would allow tile-by-tile fronts inside a
  province, which look exactly like the original game and are genuinely
  attractive. Rejected because every system in this game computes on provinces: a
  half-conquered province produces nothing partial, supplies nothing partial and
  counts for nothing partial. The result would be a prettier map and an identical
  simulation, paid for with a snapshot four orders of magnitude larger and a delta
  carrying thousands of tile ids per border change.
- **Immediate ownership transfer, no occupation period.** Simpler, but makes
  conquest weightless — territory would flip back and forth with no cost asymmetry
  between taking ground and holding it.

## Consequences

- A snapshot carries ~800 province entries instead of millions. Measured on
  realistic shapes: **4.5 KB compressed** at phase 2, ~14 KB at full feature scope.
- An ownership delta is a handful of bytes.
- Tile-level fronts are foreclosed. If they are ever wanted, this decision has to
  be revisited — it is the one that makes them impossible.
- The client expands province -> tiles locally from a static index, so the wire
  never carries tile data.
