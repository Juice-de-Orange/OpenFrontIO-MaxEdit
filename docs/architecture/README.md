# Architecture — present state

**What this document is:** how the code works _right now_, in the present tense.
It is not the plan. The plan — every system, the build phases and their gates —
is [`../../CLAUDE.md`](../../CLAUDE.md).

**Last verified:** 2026-08-30, phase 0 in progress — import cycle cut,
proprietary assets removed, nine renderer→core couplings still open.
Current step-by-step status is in [`../../HANDOVER.md`](../../HANDOVER.md).

> ⚠️ The fork is mid-surgery. Large parts of this tree are inherited upstream
> code that is being dismantled. Where that is the case, this document says so
> rather than pretending the target architecture already exists.

## The one-paragraph version

A world server owns the simulation and ticks it every five seconds. Clients
connect over a WebSocket, receive a full state view on connect and deltas
afterwards, and render. The client never simulates anything. **None of that
exists yet** — today the tree still boots upstream's lockstep client against
upstream's match server. Phase 0 is the demolition that makes room for it.

## What is inherited, and what happens to it

| Path                                              | Origin   | Fate                                                                                                                    |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/client/render/`                              | upstream | **Kept.** WebGL2 renderer, ~180 files. The most valuable inherited asset.                                               |
| `src/client/hud/`, `components/`                  | upstream | Mostly quarantined, then replaced. A few files are skeletons for later phases.                                          |
| `src/client/view/`                                | upstream | **Replaced** by a store that applies server deltas.                                                                     |
| `src/core/pathfinding/`                           | upstream | **Moves to `shared/`.** Water pathfinding and connected components are needed for sea routes and province partitioning. |
| `src/core/game/GameMap.ts`                        | upstream | **Moves to `shared/map/`.** Tile geometry and terrain queries.                                                          |
| `src/core/execution/`, `worker/`, `GameRunner.ts` | upstream | **Deleted.** This is the lockstep simulation.                                                                           |
| `src/server/`                                     | upstream | **Deleted.** Ephemeral master/worker match server; replaced by the world server.                                        |
| `src/shared/`                                     | new      | Pure rules and types used by both sides. No I/O, ever.                                                                  |
| `zbin/`                                           | upstream | Kept as a library. Currently unused by our own protocol.                                                                |
| `proprietary/`                                    | upstream | **Removed.** Logo, brand font and music, All Rights Reserved. Replaced by own marks in `resources/images/`.             |

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

`src/core` and `src/client` were a single import cycle: `core/configuration/Config.ts`
imports `client/view`, which imports back into the core worker. A lone
`import type { FrameData }` dragged 54 simulation files into the type graph.

That cycle is now cut at its head — see
[decision 0001](../decisions/0001-break-core-client-import-cycle.md). The rule
going forward:

- `shared/` imports **nothing** from `client/`, `server/` or `core/`.
- `server/` may import `shared/`.
- `client/` may import `shared/`.
- Nothing imports `core/` that is not itself scheduled for deletion.

**How to check it:** compile a file whose only content is
`import type { FrameData } from "src/client/render/types/FrameData"` with
`tsc --listFiles`, and count `src/core` entries in the output. It was 54 before
the cut and 1 after — the remaining one is `GameMap.ts`, which has not moved
yet. The exact commands are in [`../../HANDOVER.md`](../../HANDOVER.md). This
will become a permanent test.

That measurement covers the _type_ graph reachable from `FrameData`. The
renderer still has value imports into `src/core` beyond it — nine modules,
about thirty call sites, as of 2026-08-30:

| Module                       | Sites | Weight                                                        |
| ---------------------------- | ----- | ------------------------------------------------------------- |
| `core/configuration/Config`  | 10    | Only 7 methods are used; replaced by a narrow `RenderConfig`. |
| `core/AssetUrls`             | 10    | 116 lines, no imports. Trivial to move.                       |
| `core/CosmeticSchemas`       | 3     | 575 lines. Two uses are the debug effect editor.              |
| `core/game/TerrainMapLoader` | 2     | Type-only (`MapLayer`).                                       |
| `core/game/Game`             | 2     | Two enums.                                                    |
| `core/game/GameUpdates`      | 2     | Only `RailroadCache.ts`, which gets quarantined.              |
| `core/game/Veterancy`        | 1     | 23 lines, no imports.                                         |
| `core/PatternDecoder`        | 1     | Used by the preview pass.                                     |
| `core/game/GameMap`          | 1     | Moves last, once `execution/` is deleted.                     |

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
