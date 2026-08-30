# Architecture — present state

**What this document is:** how the code works _right now_, in the present tense.
It is not the plan. The plan — every system, the build phases and their gates —
is [`../../CLAUDE.md`](../../CLAUDE.md).

**Last verified:** 2026-08-30, end of phase 0. A world server ticks and pushes
province ownership; the renderer draws it. `src/core` and `src/server` are
deleted and the rest of the inherited client is quarantined. Current status is
in [`../../HANDOVER.md`](../../HANDOVER.md).

> ⚠️ The fork is mid-surgery. Large parts of this tree are inherited upstream
> code that is being dismantled. Where that is the case, this document says so
> rather than pretending the target architecture already exists.

## The one-paragraph version

A world server owns the simulation and ticks it every five seconds. Clients
connect over a WebSocket, receive a full state view on connect and deltas
afterwards, and render. The client never simulates anything.

**That is what runs.** `src/server/Main.ts` loads a map, partitions it into
provinces, and ticks every five seconds. `index.html` boots
`src/client/world/WorldClient.ts`, which connects over a WebSocket, derives
the same partition from the same terrain bytes, and hands province ownership
to the inherited renderer through one long-lived `FrameData` object.

What is not there yet is everything that makes it a _game_: no persistence
(phase 1), no economy, no units, no diplomacy. The world's only behaviour is
that one province changes hands per tick, at a border, deterministically.

## The tree, and where it came from

| Path                        | Origin   | State                                                                                                                                                                   |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/render/`        | upstream | **Kept.** WebGL2 renderer, 100 modules. The most valuable inherited asset, and the reason the fork started from this codebase.                                          |
| `src/client/world/`         | new      | The world client: entry point, map loading, palette, province tile index, frame adapter, camera, socket.                                                                |
| `src/client/util/`, `i18n/` | new      | Asset URL resolution and translation — the only two modules outside `render/` the renderer may reach.                                                                   |
| `src/client/_legacy/`       | upstream | **Quarantined.** 259 files: the HUD, components, view and controllers. Excluded from the build and every tool. See its README for the revival list and the expiry date. |
| `src/server/`               | new      | The world server. Upstream's match server of the same name was deleted; nothing of it survives.                                                                         |
| `src/shared/`               | new      | Used by both sides, no I/O: `map/` (Terrain, GameMap, TileSet, Maps.gen, ProvincePartition, TerrainHash), `pathfinding/` (19 files), `protocol/Wire.ts`, `util/`.       |
| `src/build/`                | new      | Build-time code. `PublicAssetManifest.ts`, which `vite.config.ts` needs.                                                                                                |
| `tests/_legacy/`            | upstream | **Quarantined.** ~336 files testing code that no longer exists. Kept because several are effectively the world server's specification.                                  |
| `zbin/`                     | upstream | Kept as a library, unused by our protocol.                                                                                                                              |
| `src/core/`                 | upstream | **Deleted.** The lockstep simulation.                                                                                                                                   |

What was rescued from `src/core` before it went: `GameMap`, `TileSet`,
`EventBus`, `PseudoRandom`, `DebugSpan`, `Maps.gen`, and 19 of 23 pathfinding
files. The four that were not — `PathFinder.ts`, `.Air`, `.Station`,
`spatial/SpatialQuery` — import `game/Game` and are built around upstream's
unit world; they need rewriting against a province graph in phases 2 and 9,
and are in the history until then.

## The renderer, and why it survives the surgery

The renderer is **input-pushed, not state-pulled**. Nothing inside
`src/client/render/` reaches into game state; every drawing pass is a consumer
of data handed to it through setters. The chain is:

```
state source  ->  FrameData (one long-lived object)
              ->  frame/Upload.ts  (single dispatch point)
              ->  gl/MapRenderer.ts  (public facade)
              ->  gl/Renderer.ts  ->  each Pass.draw()
```

That is what makes "keep the renderer, delete the simulation" possible at all:
the simulation is merely _a_ producer of `FrameData`, and the server can be
another. Upstream's own `src/client/render/preview/` already proves it — a
cosmetics preview that renders a real map with no simulation anywhere, building
its tile state in fifteen lines.

Three things about that contract are easy to get wrong and fail silently:

- **One long-lived tile buffer, mutated in place.** `TrailPass` keeps the array
  reference and reads it at draw time. Allocating a fresh array per tick renders
  the first frame correctly and then silently ignores every update.
- **`FrameData` is not the whole contract.** The renderer's constructor also
  requires a `RendererConfig` (map dimensions, unit types, and the player list)
  and a palette array. Territory colour comes from the palette indexed by owner
  id — not from `frameData.players`.
- **Empty is not the same as absent.** `events` must carry three empty arrays,
  not an empty object; `Upload.ts` reads `.length` before checking anything.

See [`src/client/render/CLAUDE.md`](../../src/client/render/CLAUDE.md) for the
renderer's own documentation, which is good and worth reading before touching it.

## The import boundary

`src/core` and `src/client` were once a single import cycle:
`core/configuration/Config.ts` imported `client/view`, which imported back into
the core worker, so a lone `import type { FrameData }` dragged 54 simulation
files into the type graph. Both ends of that cycle are now deleted, but the
rule it produced is the one the tree still runs on:

- `shared/` imports **nothing** from `client/` or `server/`. It is the layer
  both sides depend on, so a single edge out of it inverts the dependency.
- `client/` and `server/` may import `shared/`.
- `render/` may import `shared/` and, by name, `client/util/AssetUrl` and
  `client/i18n/Translate` — nothing else, because every other module brings
  its own imports with it. That is how `client/Utils.ts` kept 56 core files in
  the renderer's graph long after every direct import was gone.

See [decision 0001](../decisions/0001-break-core-client-import-cycle.md) for
the cut and [decision 0004](../decisions/0004-renderer-owns-its-vocabulary.md)
for the vocabulary rules that came out of it.

**How it is held.** Three mechanisms, deliberately different in kind:

- `tests/architecture/RenderBoundary.test.ts` scans every `.ts` under
  `render/`, resolves both the `src/…` alias and relative path forms, and
  asserts no edge out of `render/` beyond a named list.
- `tests/architecture/QuarantineBoundary.test.ts` asserts nothing live imports
  into `_legacy/`, and that the four exclusion lists agree. This one carries a
  self-test, because an earlier version of it passed against a deliberately
  planted violation.
- `no-restricted-imports` zones in `eslint.config.js` for `render/` and
  `shared/`, so a violation shows up in the editor before any test runs.

Each was verified by introducing a violation on purpose and watching it fail —
in both directions for the lint zones. A guard nobody has seen fail is a guard
nobody should believe.

The nine couplings that were resolved, and how:

| Module                       | Resolution                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- |
| `core/configuration/Config`  | Replaced by `RenderRules` in `render/types/` — 7 methods, structurally met. |
| `core/AssetUrls`             | Split into `shared/util/AssetPath` and `client/util/AssetUrl`.              |
| `core/CosmeticSchemas`       | Effect editor deleted; palette attribute union written out locally.         |
| `core/game/TerrainMapLoader` | `MapLayer` duplicate collapsed onto the generated catalog.                  |
| `core/game/Game`             | `GameMapType` via `shared/map/Maps.gen`; `UnitType` via the renderer's own. |
| `core/game/GameUpdates`      | `computeRailTiles` split out; the accumulator moved to `client/view/`.      |
| `core/game/Veterancy`        | Moved to `shared/util/`.                                                    |
| `core/PatternDecoder`        | Moved to `shared/util/`, constructor typed structurally.                    |
| `core/game/GameMap`          | `TileRef` is `number` in the renderer.                                      |

Plus two transitive leaks the count above missed, because they were not
`src/core` imports at all: `client/Utils.ts` (reached by three passes for
`translateText`, `renderNumber`, `renderTroops`) and
`client/TerrainMapFileLoader` (reached by the cosmetic preview). See
[decision 0004](../decisions/0004-renderer-owns-its-vocabulary.md).

## The province partition

Provinces are grown, not gridded, and the order matters:

1. A multi-source breadth-first flood from the capitals in the map manifest,
   over land only, gives each nation its territory. Because it spreads at a
   uniform rate, the boundary between two nations ends up equidistant _along
   the land_ — so it bends around bays and runs through mountains the way a
   frontier does.
2. Each territory is then cut into pieces by a flood restricted to that
   territory, with two Lloyd relaxation passes to even out the sizes.

Cutting inside a territory is what guarantees **no province straddles a
national border**: the national borders are province borders. An ownership
change therefore moves one province, and a front is a set of province edges.

Europe at quarter resolution: 529 provinces, mean node degree 3.27, no
isolated provinces, 368 ms. (The plan measured 2.66 with 160 isolated for a
naive partition, and warned it would give "corridors instead of fronts".)

The partition is **static map data**, not world state. It is never sent, never
snapshotted, and never in a delta — both sides derive it from the same terrain
bytes. `FullState.map.terrainHash` is what makes that agreement checkable; a
mismatch (one side on `map.bin`, the other on `map4x.bin`) would otherwise
show up only as quietly mis-coloured regions.

Phase 2 moves the generator offline and ships the result as a checked-in file,
so a generator bugfix cannot repartition a running season. The invariants the
tests assert — determinism, connectivity, no province spanning two nations —
carry over unchanged.

## The protocol

JSON behind `shared/protocol/Wire.ts`, with `protocolVersion` in the
handshake. The inherited `zbin` is positional and has no version field; its
own docs warn that mismatched builds decode each other _silently wrong_, which
for a world running six weeks while we deploy into it is the most expensive
failure available.

Every rejection closes the connection with a code that says why — 4001 version
mismatch, 4002 malformed, 4003 unknown world, 4004 no hello within five
seconds — and sends a `reject` frame first. Nothing is ignored. On the client
a version mismatch and a tick gap are both terminal: retrying a version
mismatch turns it into a loop that looks like a network fault, and carrying on
past a missed delta leaves a permanently wrong map with no error at all.

## Map data

Map binaries are raw `Uint8Array`, one byte per tile, no header and no version;
dimensions come from the sibling `manifest.json`. Bit 7 is land, bit 6 shoreline,
bit 5 ocean, bits 0–4 elevation, with 31 meaning impassable.

`manifest.json` also carries a `nations` list with coordinates and flags — 52 of
them on the Europe map. Those are the seeds for province generation and the
starting nations of a world.

## Where the numbers live

Every balance value belongs in `src/shared/config/`, never inline in a system.
Simulation code has no I/O, no wall-clock reads and no `Math.random()`; all
randomness derives from a seeded PRNG keyed on `(worldSeed, tick, contextId)`.
