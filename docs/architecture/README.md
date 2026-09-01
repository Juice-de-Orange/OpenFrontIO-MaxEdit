# Architecture — present state

**What this document is:** how the code works _right now_, in the present tense.
It is not the plan. The plan — every system, the build phases and their gates —
is [`../../CLAUDE.md`](../../CLAUDE.md).

**Last verified:** 2026-08-31, phases 0-5 gated, phase 6 built but not gated.
A world server ticks, persists to Postgres, accepts commands and survives being
killed; the renderer draws what it sends. Supply is written, unit-tested and
live in the tick, and its gate does not yet pass — `HANDOVER.md` says exactly
why, and the reason is in the gate rather than in the simulation. `src/core` and upstream's match server are deleted and the rest
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
toggled with `b`. A click on a province sends a `claim_province` command, which
is a standing attack order rather than a request for the province: it grinds
until the province falls or the player calls it off. The grinding is visible
tile by tile — each front carries a **progress** value that the client paints
as tiles taken from the attacking border inward, so a contested province
fills up with the attacker's colour while its controller is still the
defender's. Tiles stay a projection (decision 0002); only the paint moves.

A province has a **controller** and an **owner**. The controller moves the
tick a front's progress completes; the owner follows only after 336 ticks —
fourteen in-game days — of unbroken control (docs/decisions/0002). The map is
coloured by controller, because that is where the line is — plus the partial
front described above, because that is where the line is moving.

Underneath that is an economy: provinces extract from their deposits, factories
consume and produce, a construction queue turns construction points into
buildings over hundreds of ticks, and production lines turn industry into
equipment that divisions draw on. Research moves the rates those systems read,
and supply decides how much of it reaches a division at the end of a long
front. Nations hold standing agreements with each other and trade over them.
Air zones are in as of phase 8, and the sea as of phase 9: fleets on the
same zone machine as wings (decision 0015), sea supply between ports priced
in convoys, seaborne trade that raiders can cut, and a naval invasion whose
crossing everyone can watch. The sea routes over the sea-zone graph derived
at load (decision 0017) — water provinces do not exist.

**The border drift is gone.** From phase 1 to phase 7 a deterministic sweep
moved one province a tick regardless of who held what, so that a world with
nobody online still looked alive. It was a placeholder for the regent, and
leaving it beside a real resolver would have meant two ways to take a province,
the cheaper of which ignored terrain and supply. Between here and phase 10 an
unattended world is quiet, and that is honest: there is nobody there to attack
([decision 0014](../decisions/0014-the-border-drift-gives-way-to-a-front.md)).

## Systems, and the order they run in

`src/server/systems/` holds one module per simulation system, with the
signature `run(world, tick): Event[]`. All eleven of CLAUDE.md §6's systems are
in the list from the start; four are still empty placeholders. An empty slot in the
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
- **trade** — standing bilateral agreements, and the world market. A trade
  moves a resource one way and construction points the other, every tick, and
  a side that cannot cover its rate scales the whole exchange down rather than
  breaking it. **Construction points are the only currency**, so an import is
  felt as factories not built: the construction system asks
  `constructionAvailable` rather than measuring its own output, and that is the
  entire price mechanism. The system also writes off agreements whose notice
  has run out and whose partner has gone away — neither costs anybody trust.
  Nothing here expires: see decision 0011 for why an agreement is nothing but
  the commands that made it, `nation_present` included.
- **supply** — reach times coverage. Reach is a weighted shortest path from
  the nation's capitals and supply hubs over ground it controls, falling with
  distance and rising with the infrastructure on the way; coverage is the
  nation's total source throughput against its total demand. An under-supplied
  division loses equipment in proportion to how short it is. Since phase 9
  the sea carries the rest: a controlled port with no land way home is
  reached from a source port over the sea-zone graph — §6.6's "port on both
  ends" — at a reach that falls with zones crossed, scales with how much of
  the wanted convoy tonnage the nation holds (floored at
  `SEA_SUPPLY_FLOOR`: no convoys is badly supplied, never cut off), and is
  cut, never severed, by raiders the nation's own escorts partly cover
  (`netRaidOver`). Sea supply wears the convoys that carry it.
- **combat** — the front. Every standing attack order is asked the same
  question each tick — how does the force that can reach this border compare
  to what is holding it, with this roll — and the answer moves a **progress**
  value on the order rather than flipping the province:
  `advance = FRONT_ADVANCE × (pressed − defence) / (pressed + defence)`,
  positive when the attacker is ahead, negative when behind, clamped to 0..1,
  with control changing only when it completes (invariant 1: taking a
  province is a rate, never a lump sum). Empty ground is marched into at a
  flat rate rather than walked into in one tick. The inputs are §6.9's own —
  a division's equipment, its supply, the terrain it is attacking into, and a
  combat width that keeps a twentieth division from adding anything — and the
  roll is seeded from `(worldSeed, tick, province)`, varying the rate rather
  than flipping a coin, so the tick stays reproducible from the log. A
  _battle_ costs both sides equipment every tick, win or lose; a march costs
  nothing, which the one-tick flip used to hide. An even fight therefore goes
  nowhere on the map and is decided by the warehouses. Divisions refill from
  the stockpile, and the factories that refill it are the ones the player has
  been choosing between all along. Signing a non-aggression pact calls a
  standing attack off rather than letting it grind through the promise, and a
  called-off attack loses its progress — a front cannot be banked.

Air superiority is in that roll as of phase 8: the attacker's strength is
multiplied by what `ground_support` over the province's air zone is worth to
each side, bounded so that air shifts a fight it never decides alone.

- **air** — the sky over a zone. Formations assigned to a zone with a mission
  are resolved each tick into a **superiority ratio** per nation, clamped away
  from both 0 and 1 so the last wing in a losing air war is still worth flying.
  The system itself does two things — it charges attrition to everything in a
  contested zone, more to the losing side, and it sends home formations whose
  base was lost. It applies none of the effects. The three §6.7 lists land on
  systems that already existed and each reads the ratio where it needs it:
  ground combat through the multiplier above, supply through `supplyReach`,
  factory output through the economy's per-province figure. A pure function of
  the state is cheaper to trust than a number this system would have to store.
- **naval** — the sea war, and deliberately not a second copy of the above.
  The resolver lives in `systems/zones.ts` and knows about zones, formations
  and missions rather than about ships; what separates a fighter wing from a
  submarine flotilla is a row in `shared/economy/Formations.ts`
  ([decision 0015](../decisions/0015-one-formation-and-one-zone-machine.md)).
  The thin half this system owns: attrition in contested seas, fleets sent
  home when their harbour falls, convoys sunk where a nation's sea routes —
  supply and trade alike — cross a raided zone (exposure priced exactly as
  the consumers price the routes, escorts covering `ESCORT_COVER` of it),
  and the crossings: each `naval_invade` transit spends its ticks here and
  lands on its last one — onto an open beach, taking the province, or into
  a garrison raised while everyone watched it coming, and turns back. It
  runs _after_ supply on purpose: supply computes the demand, naval sinks
  the ships carrying it, and the shortfall lands next tick (§6's one-tick
  lag, by design). Routing runs over the sea-zone graph derived at load
  ([decision 0017](../decisions/0017-the-sea-graph-is-the-zone-graph.md));
  trade routes are resolved every tick in `systems/routes.ts`.

- **regent** — the world playing a nation nobody is (§6.10). Every twelve
  ticks, rule-based, emitting the same events a player's commands would — a
  pure function of the state, so a replay reaches the same conclusions. It
  garrisons the capital, keeps the queue non-empty (a starving division's
  supply hub first), runs rifles _and_ guns because strength is the worst
  template ratio, fills research, and buys the scarcest resource at the
  market inside its budget — its only economic reaction (invariant 7). It
  never touches an existing line's equipment type, and it is **opt-in until
  phase 11** ([decision 0018](../decisions/0018-the-regent-is-opt-in-until-identity.md)):
  the season opening is where regents switch on for unclaimed nations.

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

| Path                        | Origin   | State                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/render/`        | upstream | **Kept.** WebGL2 renderer, 100 modules. The most valuable inherited asset, and the reason the fork started from this codebase.                                                                                                                                                                            |
| `src/client/world/`         | new      | The world client: entry point, map and artefact loading, palette, province tile index, frame adapter, province border layer, camera, socket.                                                                                                                                                              |
| `src/client/util/`, `i18n/` | new      | Asset URL resolution and translation — the only two modules outside `render/` the renderer may reach.                                                                                                                                                                                                     |
| `src/client/_legacy/`       | upstream | **Quarantined.** 259 files: the HUD, components, view and controllers. Excluded from the build and every tool. See its README for the revival list and the expiry date.                                                                                                                                   |
| `src/server/`               | new      | The world server: `world/` (World, WorldState and its reducer, TickLoop, WorldRunner), `systems/` (economy, construction, production, research, trade, supply, air, naval, combat, regent, routes — victory still empty), `db/` (store interface, memory and Postgres store), `net/` (socket and health). |
| `src/shared/`               | new      | Used by both sides, no I/O: `map/` (Terrain, TerrainBits, GameMap, TileSet, Maps.gen, Province, ProvincePartition, ProvinceAttributes, ProvinceMap, TerrainHash), `economy/` (the building catalogue), `pathfinding/` (19 files), `protocol/Wire.ts`, `config/`, `util/`.                                 |
| `src/build/`                | new      | Build-time code. `PublicAssetManifest.ts`, which `vite.config.ts` needs, and `GenerateProvinceMap.ts` behind `npm run gen-provinces`.                                                                                                                                                                     |
| `tests/_legacy/`            | upstream | **Quarantined.** ~336 files testing code that no longer exists. Kept because several are effectively the world server's specification.                                                                                                                                                                    |
| `zbin/`                     | upstream | Kept as a library, unused by our protocol.                                                                                                                                                                                                                                                                |
| `src/core/`                 | upstream | **Deleted.** The lockstep simulation.                                                                                                                                                                                                                                                                     |

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
provinces as such do not exist and phase 9 decided they never need to: the
sea's adjacency, distance and paths are derived from the per-tile zones at
load, in `src/shared/map/SeaGraph.ts`
([decision 0017](../decisions/0017-the-sea-graph-is-the-zone-graph.md)). The
format keeps its version field for whatever finally does need one.

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
different world, because the systems make state of their own: construction
accrues, efficiency climbs, trade moves goods and a front costs equipment, all
without a command anywhere near them.

A world therefore resumes at the later of the newest snapshot and the newest
logged command: a hard crash costs up to five minutes of simulation and **no
player command** ([decision 0005](../decisions/0005-resume-at-the-last-durable-record.md)).

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

JSON behind `shared/protocol/Wire.ts`, version 9, with `protocolVersion` in the
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

A delta carries `control`, `owner`, `buildings` and `fronts`. The second is
empty on almost every tick, which is the point: a front moves constantly and a
map changes hands rarely. `fronts` is every standing attack in the world —
province, attacker, progress — in full every tick, public the way `control`
is public: the defender watches themselves being ground down, and every
client, spectators included, paints the partial progress as tiles, which it
could not do for a front it is not told about.

**Identity lives beside the world** (phase 11, decision 0019): accounts and
nation claims are Postgres tables the socket consults, never simulation
state — no snapshot, no hash, no replay dependency. `WORLD_SEASON=open` arms
it: playing a nation then needs the token `POST /register` returned exactly
once (only its SHA-256 is stored), the first hello claims a free nation, one
account holds one nation, a newer connection from the same account
supersedes the older (close 4006, terminal), and the season opening switches
regents on for every unclaimed nation through real `configure_regent`
commands in the log. Without the flag the world is the workbench the gates
run on.

**An economy is private.** The map half of a delta is identical for everybody
and is encoded once; the economy half is built per session and carries only
that nation's own stockpile, rates and construction queue. A spectator gets
`null`.

**Diplomacy is half public**, and the line is drawn on the server where §7 puts
it. Every nation's trust rides on every full state and every delta, to
everybody, because a trust value nobody can see would change nobody's
behaviour. Agreements ride the same way, but `terms` comes back `null` on any
agreement the session is not a party to: the world can see that two nations are
talking and only the two of them can see what about. The list is sent whole
rather than diffed — there are a few dozen of them, and an offer arriving is
the one message a diff would be unforgivable for losing.

One command on that list is not a player's: `nation_present`, which the socket
layer sends on behalf of a session when it connects and every so often while it
stays. §6.5's dead-partner rule needs to know when a nation was last played and
§4 requires that to be reconstructible from the log alone, so presence is a
command like any other (decision 0011).

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
