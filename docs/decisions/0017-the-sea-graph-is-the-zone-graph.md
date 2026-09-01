# 0017 — The sea's graph is the sea-zone graph; water provinces do not exist

- **Status:** Accepted
- **Date:** 2026-09-01
- **Phase:** 9

## Context

HANDOVER.md's phase-9 plan began with "water provinces": a `provinces.bin`
format bump giving the ocean the same partition the land has, because "phase 9
needs water provinces to move and fight over". That step carried most of the
phase's risk — a new byte layout, a regenerated artefact, two independent
re-parsers to update, and every running world invalidated by the partition
hash.

Reading the actual consumers first changed the answer. Everything the sea has
to support asks one of three questions:

- **Which zones touch which?** Convoy routes and invasion paths cross zones.
- **How far apart are two coasts, at sea?** Convoy consumption is priced per
  zone crossed.
- **What path does a crossing take?** The transit is visible per zone, and
  raiders are looked for along it.

All three are properties of the sea _zones_ the artefact already stores per
tile. Fighting happens per zone (`zones.ts`, decision 0015); fleets are
assigned per zone; nothing anywhere addresses an individual patch of ocean the
way land systems address a province. A water province would have been a node
nobody asked a question of.

## Decision

`src/shared/map/SeaGraph.ts` derives the sea's adjacency from `seaZoneOfTile`
at load — one linear pass, cached per decoded map, exactly the way
`borderTiles` is derived — and offers `seaPath`/`seaDistance` over it. The
artefact format stays at 1, nothing is regenerated, and no running world is
invalidated.

Note the deliberate difference from `zoneNeighbours(map, "naval")` in
`server/systems/zones.ts`: that derivation runs through coastal land
provinces, which is right for its question — where a fleet based at a port may
be _sent_ (`ZONE_REACH`) — and wrong for routing, because two zones meeting in
open ocean share no coastal province. Two questions, two graphs, each derived
where it is asked.

## Alternatives rejected

- **Water provinces (the plan's step 1).** All of the format-bump risk for a
  graph node no system queries. If a later phase wants finer water — say,
  weather, or a canal a province can close — the format has a version field
  and this decision is where to start the argument.
- **Deriving adjacency inside each consumer.** Three consumers, three chances
  to disagree about what "touching" means. One module, one cache.

## Consequences

- Phase 9 ships with no artefact change: sea supply, seaborne trade, raiding
  and invasion all route over `SeaGraph`.
- Sea distance is measured in zones crossed (Europe has 35), which makes the
  convoy constants coarse. If routes ever need finer pricing, subdividing the
  _zones_ is a data change, not a format change.
- Test fixtures must set the ocean bit: bare-zero water is a lake, and lakes
  have no graph ("sea zones are the ocean, not the water", phase 2's lesson).
