# Architecture — present state

**What this document is:** how the code works _right now_, in the present tense.
It is not the plan. The plan — every system, the build phases and their gates —
is [`../../CLAUDE.md`](../../CLAUDE.md).

**Last verified:** 2026-08-31, phases 0-6 gated. A world server ticks, persists
to Postgres, accepts commands and survives being killed; the renderer draws
what it sends. `src/core` and upstream's match server are deleted and the rest
of the inherited client is quarantined. Current status is in
[`../../HANDOVER.md`](../../HANDOVER.md).

> ⚠️ The fork is mid-surgery. Large parts of this tree are inherited upstream
> code that is being dismantled. Where that is the case, this document says so
> rather than pretending the target architecture already exists.

## The one-paragraph version

A world server owns the simulation and ticks it every five seconds. Clients
connect over a WebSocket, receive a full state view on connect and deltas
afterwards, send commands, and render. The client never simulates anything.

**That is what runs.** `src/server/Main.ts` loads a map and its province
artefact, takes an advisory lock on its world id, replays whatever the database
remembers, and starts a clock. `index.html` boots
`src/client/world/WorldClient.ts`, which connects over a WebSocket, loads the
same artefact, and hands province control to the inherited renderer through one
long-lived `FrameData` object — plus a province-border overlay as a map layer,
toggled with `b`. A click on a province sends a `claim_province` command.

A province has a **controller** and an **owner**. The controller moves the tick
it is taken; the owner follows only after 336 ticks — fourteen in-game days —
of unbroken control (docs/decisions/0002). The map is coloured by controller,
because that is where the line is.

Underneath that is an economy: provinces extract from their deposits, factories
consume and produce, a construction queue turns construction points into
buildings over hundreds of ticks, and production lines turn industry into
equipment that divisions draw on. Research moves the rates those systems read,
and supply decides how much of it reaches a division at the end of a long
front. What is still not there is everything diplomatic and the rest of what is
military — no zones, no agreements, no convoys, and no real combat resolution.

The border drift remains: one province changes hands per tick, at a border,
deterministically. A heartbeat, kept because a persistent world has to look
alive with nobody online, and because it is what makes the replay test hard
enough to be worth running. Since phase 4 it costs both sides equipment, and
§6.9's resolution replaces its insides in phase 9.

## Systems, and the order they run in

`src/server/systems/` holds one module per simulation system, with the
signature `run(world, tick): Event[]`. All eleven of CLAUDE.md §6's systems are
in the list from the start; nine are empty placeholders. An empty slot in the
right place is worth more than a short list that has to be reordered later,
because reordering is how a dependency gets inverted without anyone noticing.

```
economy → construction → production → research → trade → supply →
air → naval → combat → regent → victory
```

**Events are the only mutation.** A system returns events; nothing outside the
reducer in `world/WorldState.ts` writes to world state. Each system's events
are applied before the next system runs (docs/decisions/0007) — the order only
encodes real dependencies if a later system can see what an earlier one did.

**No system does I/O, reads a clock, or calls `Math.random()`.** That is what
makes a tick a pure function of `(state, tick)`, which is what the whole
persistence design rests on.

### What is filled in

- **economy** — provinces extract from their deposits, scaled by
  infrastructure, extraction upgrades and whether the province is occupied.
  Military factories and dockyards draw resources; synthetic refineries convert
  steel at a deliberately unfavourable rate. Manpower regrows toward a ceiling
  set by land the nation both owns and holds (docs/decisions/0008).
- **construction** — civilian factories make construction points, points accrue
  into the front item of the nation's queue, and a building appears when the
  accrued progress passes its cost.
- **production** — factories assigned to a line turn industry into equipment.
  A line's efficiency climbs while it runs and is **thrown back to the floor
  whenever its equipment type changes**; adding or removing factories never
  touches it. Divisions then draw from the stockpile toward full strength.
- **research** — a slot works on one tech, one tick at a time, and the nation
  keeps it for good. The system does not apply the modifiers: every rate is
  read through `nationModifiers`, `factoryOutput` or `efficiencyCapFor` at the
  moment it is used, so there is one source of truth and a restored world
  cannot come back with a stale copy of its own bonuses (decision 0010).
- **supply** — reach times coverage. Reach is a weighted shortest path from
  the nation's capitals and supply hubs over ground it controls, falling with
  distance and rising with the infrastructure on the way; coverage is the
  nation's total source throughput against its total demand. An under-supplied
  division loses equipment in proportion to how short it is. Land only: the
  sea path waits for convoys in phase 9.
- **combat** — the border drift, which since phase 1 has moved one province a
  tick to keep an empty world alive, now costs the divisions on both sides
  equipment. That is the smallest honest version of invariant 6: a fight
  empties divisions, divisions refill from the stockpile, and the factories
  that refill it are the ones the player has been choosing between all along.

§6.9's real resolution — combat width, terrain, air superiority, a seeded roll
— is phase 9. Division strength is computed and published from phase 4 on;
phase 9 is what consumes it.

One **sufficiency** figure per nation, the worst of the per-resource ratios,
scales every consumer down together. That is invariant 2 — _everything
degrades, never hard-blocks_ — and taking the worst ratio rather than one per
resource is deliberate: a factory needs all of its inputs, so scaling each
input separately would let a nation with plenty of aluminium and no steel keep
producing on nothing.

Civilian factories draw no resources, so construction points do not depend on
the stockpile. That is what lets the construction system recompute them rather
than have them handed down, and it removes the one place the two could
disagree.

## The tree, and where it came from

| Path                        | Origin   | State                                                                                                                                                                                                                                                                     |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/render/`        | upstream | **Kept.** WebGL2 renderer, 100 modules. The most valuable inherited asset, and the reason the fork started from this codebase.                                                                                                                                            |
| `src/client/world/`         | new      | The world client: entry point, map and artefact loading, palette, province tile index, frame adapter, province border layer, camera, socket.                                                                                                                              |
| `src/client/util/`, `i18n/` | new      | Asset URL resolution and translation — the only two modules outside `render/` the renderer may reach.                                                                                                                                                                     |
| `src/client/_legacy/`       | upstream | **Quarantined.** 259 files: the HUD, components, view and controllers. Excluded from the build and every tool. See its README for the revival list and the expiry date.                                                                                                   |
| `src/server/`               | new      | The world server: `world/` (World, WorldState and its reducer, TickLoop, WorldRunner), `systems/` (economy, construction, production, research, supply, combat, and the five still empty), `db/` (store interface, memory and Postgres store), `net/` (socket and health).                 |
| `src/shared/`               | new      | Used by both sides, no I/O: `map/` (Terrain, TerrainBits, GameMap, TileSet, Maps.gen, Province, ProvincePartition, ProvinceAttributes, ProvinceMap, TerrainHash), `economy/` (the building catalogue), `pathfinding/` (19 files), `protocol/Wire.ts`, `config/`, `util/`. |
| `src/build/`                | new      | Build-time code. `PublicAssetManifest.ts`, which `vite.config.ts` needs, and `GenerateProvinceMap.ts` behind `npm run gen-provinces`.                                                                                                                                     |
| `tests/_legacy/`            | upstream | **Quarantined.** ~336 files testing code that no longer exists. Kept because several are effectively the world server's specification.                                                                                                                                    |
| `zbin/`                     | upstream | Kept as a library, unused by our protocol.                                                                                                                                                                                                                                |
| `src/core/`                 | upstream | **Deleted.** The lockstep simulation.                                                                                                                                                                                                                                     |

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
isolated provinces. (The plan measured 2.66 with 160 isolated for a naive
partition, and warned it would give "corridors instead of fronts".)

### It is generated once, not at startup

The partition is **static map data**, not world state. Since phase 2 it is not
recomputed either: `npm run gen-provinces` writes it next to the terrain bytes
and everything else loads it (docs/decisions/0006). Nothing on a startup path
calls `computeProvincePartition` any more.

```
resources/maps/europe/
  map4x.bin       1.2 MB   terrain, one byte per tile
  provinces.bin   2.3 MB   32-byte header + one Uint16 per tile
  provinces.json  213 kB   one record per province
```

The `Uint16` carries two partitions at once: a land tile holds its province id,
a water tile holds its sea zone with bit 15 set. Land ids never approach 0x8000
— a nation is capped at 40 provinces.

`FullState.map.partitionHash` (FNV-1a over the whole binary) is what makes the
two sides' agreement checkable, with `terrainHash` beside it because the
artefact and the terrain are two files that can also drift apart. A client on a
stale `provinces.bin` out of its HTTP cache is refused; without the hash it
would simply mis-colour regions and say nothing.

### What a province knows

Everything below is derived by the generator and never changes while a season
runs. Ownership is not in here — that is world state, and lives in `World`.

| Field                               | How it is derived                                             |
| ----------------------------------- | ------------------------------------------------------------- |
| `terrain`                           | majority `TerrainType` of the province's land tiles           |
| `infrastructure` (0–10)             | terrain, +1 coastal, +2 capital                               |
| `buildingSlots`                     | land tiles / 250, clamped, +2 capital                         |
| `resourceDeposits`                  | seeded roll per `(terrainHash, provinceId)`, terrain-weighted |
| `airZone`                           | capacity-limited growth over the province graph, ~22 each     |
| `seaZone`                           | the ocean zone most of its coastline touches, or null         |
| `neighbours`, `centre`, `tileCount` | from the partition                                            |

The deposit roll is keyed on the map's terrain hash rather than on a world
seed, on purpose: deposits are geography, so two worlds on Europe find their
coal in the same mountains. Every number the derivation uses is in
`src/shared/config/provinces.ts`.

Sea zones are cut from the **ocean**, not from water in general — an inland
lake is not a theatre, and zoning it gave landlocked provinces a navy. Water
provinces as such are phase 9; the format has a version field for it.

## Time, and what a restart costs

The tick is the only clock the simulation sees. `TickLoop` computes every
deadline absolutely from an epoch — `epoch + tick * tickMs` — so a late tick
does not shift the next one, and it awaits each tick before scheduling the
following one, so two can never run at once.

The epoch is derived from the tick the world _resumes_ at, not from a fixed
world beginning. That is what makes re-simulating an outage structurally
impossible rather than bounded by a limit somebody has to tune
([decision 0003](../decisions/0003-tick-anchored-time.md)).

Two things are durable: every accepted command, written immediately and tagged
with the tick it takes effect on, and a full snapshot every 60 ticks. On
startup the newest snapshot is loaded and the world is _run forward_ through
every tick after it, with the logged commands fed in on their own ticks —
replaying commands without running the ticks between them would land in a
different world, because the drift is part of the state.

A world therefore resumes at the later of the newest snapshot and the newest
logged command: a hard crash costs up to five minutes of drift and **no player
command** ([decision 0005](../decisions/0005-resume-at-the-last-durable-record.md)).

Three rules hold the command path together, and all three are in `WorldRunner`:

- A command is written to the log **before** it is queued, and refused if the
  write fails. A command acknowledged but not recorded would vanish at the next
  restart.
- Ticks and command submissions are serialised onto one chain. Both are async
  and both decide things from the current tick; interleaved, a command could be
  logged for one tick and queued for another.
- Commands are validated twice — on arrival, so the player is told at once, and
  again on the tick they apply, because the world moved in between. The second
  check depends only on state and tick, so a replay makes the same decision.

## One world, one process

The server takes a Postgres advisory lock keyed on its world id, on a
connection of its own outside the pool, and holds it for the life of the
process. If it cannot get the lock it exits; if the connection later drops it
stops. Two processes ticking one world would both append to its command log,
and afterwards the log would describe a run neither of them had.

## The protocol

JSON behind `shared/protocol/Wire.ts`, version 6, with `protocolVersion` in the
handshake. The inherited `zbin` is positional and has no version field; its
own docs warn that mismatched builds decode each other _silently wrong_, which
for a world running six weeks while we deploy into it is the most expensive
failure available.

Every rejection closes the connection with a code that says why — 4001 version
mismatch, 4002 malformed, 4003 unknown world, 4004 no hello within five
seconds, 4005 unauthorised — and sends a `reject` frame first. Nothing is
ignored. On the client a version mismatch and a tick gap are both terminal:
retrying a version mismatch turns it into a loop that looks like a network
fault, and carrying on past a missed delta leaves a permanently wrong map with
no error at all.

The one thing answered rather than closed is a command the world refuses on its
merits. "You cannot claim that province" is a game rule, not a protocol
violation, so it comes back as an `ack` carrying the command's id and a reason.
Every command gets exactly one ack — including the ones a dropped connection
ate, which the client fails locally rather than leaving a click that produced
nothing and explained nothing.

A delta carries `control`, `owner` and `buildings`. The second is empty on
almost every tick, which is the point: a front moves constantly and a map
changes hands rarely.

**An economy is private.** The map half of a delta is identical for everybody
and is encoded once; the economy half is built per session and carries only
that nation's own stockpile, rates and construction queue. A spectator gets
`null`. Trust and agreement terms in phase 7 get the same treatment, with the
public/private line where §7 puts it.

`/health` shares the socket's port. It reports the tick, the lag, the age of
the newest snapshot and the state hash, and returns 503 when the world is up
and stuck — which is the failure a status-code check cannot see.

## Map data

Map binaries are raw `Uint8Array`, one byte per tile, no header and no version;
dimensions come from the sibling `manifest.json`. Bit 7 is land, bit 6 shoreline,
bit 5 ocean, bits 0–4 elevation, with 31 meaning impassable.

`manifest.json` also carries a `nations` list with coordinates and flags — 52 of
them on the Europe map. Those are the seeds for province generation and the
starting nations of a world.

The byte layout is stated once, in `src/shared/map/TerrainBits.ts`.
`GameMapImpl` keeps its own copy private; `tests/shared/TerrainBits.test.ts`
compares the two over all 256 possible bytes, because a wrong bit here does not
throw — it puts the mountains somewhere else.

## Where the numbers live

Every balance value belongs in `src/shared/config/`, never inline in a system.
Simulation code has no I/O, no wall-clock reads and no `Math.random()`; all
randomness derives from a seeded PRNG keyed on `(worldSeed, tick, contextId)`.

- `config/time.ts` — the tick, the day, the snapshot interval.
- `config/provinces.ts` — everything the province generator derives.
- `config/rates.ts` — every per-tick rate in the economy.
- `economy/Buildings.ts` — what can be built, and what it costs.

And per invariant 9, no player ever sees a per-tick figure.
`client/world/ui/Format.ts` is the only place a rate becomes a per-day one, a
capacity becomes a filled fraction, or a modifier gets its sign — one place it
can be got wrong, with a test for each rule.
