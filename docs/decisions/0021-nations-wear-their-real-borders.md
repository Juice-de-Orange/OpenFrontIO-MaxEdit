# 0021 — Nations wear their real borders

- **Status:** Accepted
- **Date:** 2026-09-01
- **Phase:** map (after phase 8; deliberately after the mechanics settled)

## Context

Nation territory was grown from the capitals: a breadth-first flood over the
land, every border equidistant between two capitals. That gave every nation
_a_ territory, but the borders were nobody's borders — France ended where
Paris stopped being closer than Bern. The map this game plays on is a
hand-drawn Europe, and the one thing everyone knows about Europe is where
the countries are.

The hard part is that the drawn map is not a Mercator projection, or any
projection. It is art, with artistic distortions, so real geometry cannot be
projected onto it — it has to be _registered_ to it, the way a scanned page
is registered to a template.

## Decision

**Natural Earth 1:50m admin-0 map units, registered onto the tile grid by a
fitted transform, evaluated at build time.**

- The registration was fitted offline: a 12-parameter quadratic warp from
  map pixel space into a lon/mercator grid, refined by a 21×13 elastic
  displacement field, optimised for coastline overlap (IoU 0.881) with the
  52 spawn points as anchors (mean miss 0.3 grid cells). Only the fitted
  numbers are checked in (`borders-fit.json`), beside the filtered geometry
  (`ne-borders.geojson`, public domain). The fitting script was scaffolding,
  like the hand that drew the map; the parameters are map data.
- `src/build/NationBorders.ts` evaluates the transform per tile — pure
  arithmetic, so `gen-provinces` reproduces the artefact bit for bit and
  the regeneration test keeps meaning something.
- **Every capital claims a 12-tile disk.** Monaco and Andorra are smaller
  than a tile at real scale; the disk is what keeps them playable as
  city-states, and it also absorbs the residual registration error at
  coastal capitals. 52 of 52 spawns sit in their own nation.
- **Assigned islands below 24 tiles drown**; drawn coastline the atlas
  disagrees with floods from the nearest owner, so the map keeps its shape.
- **Sápmi is a drawn line, honestly labelled as one**: everything Natural
  Earth gives to Norway, Sweden or Finland above 67.5°N. No atlas will hand
  us that border, and the map has always had the nation.
- **Belgium is assembled from its three regional units; Serbia from Serbia,
  Vojvodina and Kosovo.** The latter is a game-data call that keeps the
  52-nation roster as it is, not a statement about anything else.

Two consequences ran deeper than the lookup:

- Islands now belong to nations (Sicily, Sardinia, Crete, the Balearics
  were unassignable by the capital flood), so a nation's territory is no
  longer connected. Detached pieces become provinces of their own rather
  than fusing with a mainland province across open water, and a nation with
  an archipelago may exceed the per-nation province cap by its islands.
- Air zones partition the province graph, and one-province island zones are
  not theatres: a component too small to be a zone joins the sky over the
  nearest zoned province, and a split pass rebalances any zone the strays
  push past the maximum.

## Alternatives rejected

- **Transforming the polygons at runtime.** Two implementations of the same
  truth (fit evaluation in the generator and in the server) with nothing to
  check them against each other.
- **Redrawing the map on a real projection.** The drawn map is the game's
  look and the most valuable inherited asset; the border data must come to
  the map, not the map to the data.
- **Hand-tracing the borders.** 52 countries of tracing, and every future
  map needs it again. The fit is reusable machinery.

## Consequences

- Partition hash changed (`d75798a4`): every running world refuses its
  snapshot. Ship at a season boundary; locally, `docker compose down -v`.
- Europe: 677 provinces, 31 air zones, 35 sea zones — all within the
  ranges the config promises.
- 99.7% of drawn land is assigned. The remainder is small islands with no
  nation to belong to (Cyprus, the Faroes, the high-Arctic specks), exactly
  the tiles the capital flood also left unowned.
