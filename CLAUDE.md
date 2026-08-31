# CLAUDE.md — OpenFrontIO-MaxEdit

Persistent-world grand strategy game. Fork of OpenFrontIO, rebuilt around a
slow economic simulation with Hearts of Iron IV mechanics reduced to their
essentials.

Repo: `https://github.com/Juice-de-Orange/OpenFrontIO-MaxEdit`
Deploy target: Docker Compose on a Linux host, behind a reverse proxy that
terminates TLS. See `docs/deploy/` for a generic self-hosting guide. Notes for
the specific machine this world runs on are deliberately **not** in this
repository — the repo is public, so host names, ports and paths live in a
git-ignored `docs/deploy/HOST.local.md`.

---

## 1. What this is, and what upstream is not

Upstream OpenFrontIO is a fast, ephemeral, match-based RTS built on
deterministic lockstep: client and server run identical simulation logic over
identical turn data, with a master-worker server spawning short-lived game
instances.

This fork is a **persistent world**. The world runs continuously, whether or
not any given player is connected. That single change invalidates most of
upstream's server architecture and roughly half of its client architecture.

**Do not preserve lockstep.** Do not preserve client-side prediction. Do not
preserve the ephemeral lobby lifecycle. A player joining a world that has been
running for three weeks cannot replay 400,000 ticks to reach sync. The server
is the sole authority; the client is a renderer.

### What we keep from upstream

- Map rendering, tile territory rendering, graphics layers
- Map data and the Go map generator
- Water pathfinding and boat movement
- WebSocket transport scaffolding
- Vite build pipeline, TypeScript config, test setup
- UI component patterns and the EventBus input handling
- Pathfinding primitives

### What we remove

- `src/core` deterministic lockstep simulation as used _on the client_
- Turn distribution and desync detection
- Master-worker ephemeral `GameServer` lifecycle
- Match lobby (replaced by world selection and nation registration)
- Client-side prediction and rollback

### Licence

Upstream is AGPL-3.0. This is a network service, so the source of this fork
must remain publicly available. Keep the repo public and keep upstream
attribution and licence headers intact. Assets from upstream are CC BY-SA 4.0;
respect that separately.

---

## 2. Design invariants

**These are the rules that make the game feel like one developer built it.**
Every system below obeys all of them. When adding anything new, check it
against this list first. A mechanic that needs an exception here is the wrong
mechanic, no matter how good it is in isolation.

1. **Everything is a rate, never a lump sum.** Factories produce per tick,
   trade flows per tick, construction accrues per tick. Nothing completes
   instantly and nothing arrives in a batch. A player who watches any number in
   the game should see it move.
2. **Everything degrades, never hard-blocks.** Resource shortage scales output
   down proportionally. Low supply weakens units. Missing equipment weakens
   divisions. No system ever refuses to run; it runs worse. This is the single
   most important consistency rule, because it is what makes the game readable:
   a player is never confronted with a wall, only with a number that got worse.
3. **Every commitment is indefinite, with a cost to break.** No timers on
   agreements, no renewal prompts, no expiry notifications. Duration is never
   the balancing lever; the exit cost is.
4. **The player allocates, never micromanages.** Wings go to zones. Fleets go
   to zones. Factories go to production lines. Construction points go to a
   queue. The player never commands an individual aircraft, ship, or truck.
5. **One zone abstraction.** Air zones and sea zones are the same code, the
   same assignment UI, and the same per-tick resolution loop with different
   mission sets. Any third zoned system reuses it again.
6. **Every hostile action has an economic footprint.** Bombing cuts factory
   output. Raiding sinks convoys, which are equipment, which cost dockyard
   time. There is no purely military action whose effect is invisible in the
   economy screen.
7. **Nothing irreversible happens without the player.** The regent, and any
   automation, may spend, build, defend, and reroute. It may never create or
   break an obligation, declare war, or abandon a capital.
8. **The province is the unit of interaction everywhere.** Economy, supply,
   combat, diplomacy targeting, and zone membership all resolve to provinces.
   Tiles exist for rendering only and are never addressable by a player action.
9. **One number vocabulary in the UI.** Rates are shown per in-game day, not
   per tick. Capacities are shown as a filled fraction. Modifiers are shown as
   signed percentages. Never mix conventions between screens.

---

## 3. Architecture

```
Browser
  ├── renderer (kept from upstream)   — draws tiles, provinces, units, UI
  └── state store                     — applies server deltas, no simulation
         │  WebSocket: commands up, deltas down
         ▼
World server (Node + TypeScript)
  ├── authoritative in-memory world state
  ├── tick loop, 5s wall clock
  ├── command queue (validated player intents)
  └── systems: economy, construction, production, research, trade, supply,
                air, naval, combat, regent, victory
         │
         ▼
Postgres
  ├── append-only command log
  ├── periodic world snapshots
  └── relational tables for accounts, worlds, nations
```

### Stack

- Client: TypeScript, Vite, canvas rendering (inherited)
- Server: TypeScript on Node, `ws` for WebSocket
- Database: PostgreSQL with Drizzle ORM
- Container: Docker Compose
- Ingress: a reverse proxy terminating TLS and forwarding the WebSocket with
  `Upgrade`/`Connection` headers and a long read timeout. If port 443 on the
  host is already taken by an SNI `stream` router (as on the machine this world
  runs on), the vhost listens on a private loopback port behind
  `proxy_protocol` instead and registers itself in that router's SNI map.

### Package layout

```
src/
  client/       renderer, UI, state store
  shared/       types, protocol schemas, pure game rules (no I/O)
  server/
    world/      tick loop, world lifecycle, snapshot + restore
    systems/    one module per simulation system
    net/        WebSocket handlers, command validation
    db/         Drizzle schema and queries
```

`shared/` holds pure functions and constants used by both sides for display
purposes (e.g. computing a build cost for the UI). The server never trusts a
client-computed value.

---

## 4. Time and persistence

### Tick

- One tick every **5 seconds** of wall clock.
- One tick represents **one in-game hour**. 24 ticks = one in-game day = two
  minutes real time.
- Tick rate is a _resolution_ choice, not a speed choice. How fast the world
  feels is controlled entirely by per-tick production and construction rates in
  `shared/config/rates.ts`. Start these deliberately low. They are the primary
  balance lever and will be retuned repeatedly.
- Per invariant 9, the UI never shows a per-tick figure. Multiply by 24 and
  label it per day.
- A world runs as a **season** with a defined end condition (victory threshold
  or fixed duration, default 6 weeks), then archives and a fresh world opens.
  Persistent worlds without an end state go stale and become unwinnable for new
  players.

### Persistence model

Per-tick database writes are not viable at this tick rate (17,280 ticks/day).

- World state is authoritative **in memory**.
- Every accepted player command is appended to `commands` in Postgres,
  immediately, with its target tick number.
- A full world snapshot is written every **60 ticks** (5 minutes) to
  `snapshots`, as compressed JSON or msgpack.
- On startup: load the latest snapshot, replay all commands with
  `tick > snapshot.tick`, resume. Maximum data loss on hard crash is 5 minutes
  of simulation, and zero player commands.
- Diplomatic state is long-lived bilateral state and must be in the snapshot.
  It must also be fully derivable from the command log alone, so agreements are
  represented as accumulated commands, never as server-side side effects.
- Acquire a Postgres advisory lock keyed on `world_id` at startup. Two
  containers must never tick the same world.

### Client synchronisation

- On connect: server sends a full state view scoped to what that nation can see.
- Thereafter: per-tick deltas, batched. Do not send a delta every tick to every
  client — batch to roughly 1 Hz, or only on change.
- Reconnect is a fresh full-state fetch, not a replay.

---

## 5. Domain model

### Map: tiles plus province graph

Keep upstream's tile-based territory for **ownership and rendering**. This is
what gives the game its look and it is the most valuable inherited code.

Layer a **province graph** on top for all simulation. Each province owns a set
of tiles. Ownership of a province derives from the majority owner of its tiles.
Per invariant 8, all systems operate on provinces, never on tiles.

```ts
interface Province {
  id: ProvinceId;
  tiles: TileId[];
  neighbours: ProvinceId[];
  airZone: ZoneId;
  seaZone: ZoneId | null; // coastal and water provinces only
  terrain: Terrain;
  infrastructure: number; // 0..10, affects supply and construction
  buildingSlots: number;
  resourceDeposits: Partial<Record<Resource, number>>;
  owner: NationId | null;
  controller: NationId | null; // differs from owner when occupied
}
```

Target roughly 300–800 provinces per map. This keeps a tick cheap.

### Resources

Four only: `steel`, `oil`, `aluminium`, `rubber`. Produced by provinces,
consumed by military factories, dockyards, and units in the field. Per
invariant 2, shortages scale output down proportionally and never hard-block.

### Nation

```ts
interface Nation {
  id: NationId;
  playerId: PlayerId | null;
  provinces: ProvinceId[];
  manpower: number;
  stockpile: Record<EquipmentType, number>;
  resources: Record<Resource, number>;
  constructionQueue: ConstructionOrder[];
  productionLines: ProductionLine[];
  researchSlots: ResearchSlot[];
  unlockedTechs: TechId[];
  relations: Map<NationId, Relation>;
  agreements: AgreementId[];
  trust: number; // 0..100, see 6.6
  regent: RegentConfig;
}
```

---

## 6. Game systems

Each system is a pure-ish module with the signature
`run(world: WorldState, tick: number): Event[]`. Systems execute in a fixed
order each tick. Events are the only mutation mechanism, applied by the world
reducer after all systems have run. This keeps the tick deterministic and
makes the event log meaningful.

Order: `economy → construction → production → research → trade → supply →
air → naval → combat → regent → victory`.

Rationale for the order, since it encodes real dependencies:

- Trade runs before supply because imported resources must be available before
  supply consumption is computed.
- Air runs before naval because air superiority modifies naval combat.
- Naval runs before supply consumption settles convoy losses... **no**: naval
  runs after supply so that convoy demand is known before raiding is applied
  against it. Supply computes demand, naval destroys the convoys carrying it,
  and the shortfall lands on the following tick. This one-tick lag is
  intentional and must not be "fixed" — resolving it in-tick creates a circular
  dependency between supply and naval.

### 6.1 Factories and building slots

The backbone. Everything else depends on it.

- Each province has a limited number of building slots.
- **Civilian factories** produce construction points. Construction points are
  allocated to items in the construction queue, and are also the currency of
  trade (see 6.5).
- **Military factories** are each assigned to exactly one production line
  producing one equipment type.
- **Dockyards** work like military factories but may only be built in coastal
  provinces and may only produce naval equipment, including convoys.
- **Synthetic refineries** convert `steel` into `oil` or `rubber` at an
  unfavourable ratio. This is the answer to being resource-starved without a
  trade partner, and it gives landlocked nations a path that does not depend on
  diplomacy.
- Buildable: civilian factory, military factory, dockyard, synthetic refinery,
  infrastructure level, air base, naval base, supply hub, resource extraction
  upgrade.
- Construction cost is paid over many ticks, not instantly. Partial progress
  persists.

### 6.2 Production efficiency

The mechanic that rewards the slow, committed play style this game is built
for. Cheap to implement, disproportionately large effect on how the game feels.

- Every production line has an efficiency value from a floor (default 10%) to a
  cap (default 100%), and climbs slowly each tick it runs uninterrupted.
- Actual output = assigned factories × base rate × efficiency.
- **Switching a line's equipment type resets efficiency to the floor.**
  Adding or removing factories from a line does not reset it.
- Consequence: a player who commits to producing one thing for a long time
  massively out-produces a player who reacts constantly. That is the intended
  lesson and the reason the game is not fast paced.
- **Interaction warning**: this is why the regent must never reassign an
  existing production line. See 6.9.

### 6.3 Equipment stockpile

Units are never built directly. This is the mechanic that makes the economy
felt rather than watched.

- Production lines deposit equipment into a national stockpile each tick.
- Divisions, air wings, and fleets draw equipment from the stockpile to reach
  full strength.
- Combat losses **destroy equipment**, permanently removing it from the
  stockpile.
- A unit below full equipment fights at reduced strength, scaled linearly.
- Equipment types (MVP): `infantry_equipment`, `artillery`, `armour`,
  `fighter`, `bomber`, `transport`, `convoy`, `submarine`, `escort`,
  `capital_ship`.
- `convoy` is equipment, not a unit. It is consumed by sea supply and by
  seaborne trade, and sunk by enemy raiding. Losing convoys is how a naval war
  is felt in the economy.

### 6.4 Research

Cheapest system to build. Keep it that way.

- N research slots, default 2, expandable to 4 via tech.
- A slot researches one tech over a fixed number of ticks.
- Techs grant flat modifiers (production efficiency cap, supply range, combat
  stats, refinery ratio, convoy capacity) and unlock higher equipment tiers.
- No focus tree. No doctrine tree. A flat list with prerequisites is enough.

### 6.5 Diplomacy and trade

Per invariant 3, **every agreement here is indefinite**. There are no
durations, no expiry, and no renewal prompts anywhere in this system. Balance
comes entirely from the cost of breaking an agreement.

#### Agreement types

All are bilateral, all are proposed by one nation and accepted by the other,
and all persist until explicitly cancelled.

- `non_aggression` — neither side may order an attack on the other.
- `trade` — a standing per-tick exchange, see below.
- `alliance` — non-aggression, plus mutual transit rights, plus shared victory
  eligibility.
- `military_access` — transit rights without the rest.

#### Trade agreements

- A trade agreement is a standing per-tick flow: nation A sends a fixed rate of
  one resource, nation B sends a fixed rate of construction points in return.
  Both sides see the exact rates before accepting.
- Construction points as the trade currency is deliberate: it means importing
  resources directly competes with building factories, so trade has a real
  opportunity cost and needs no separate currency system.
- **If the route crosses water, it consumes `convoy` equipment**, exactly like
  sea supply does. Seaborne trade is therefore raidable. This is the coupling
  that ties diplomacy, economy, and the naval system into one mechanism instead
  of three.
- If either side cannot cover its rate this tick, the flow scales down
  proportionally for that tick, per invariant 2. It does not break the
  agreement.
- A **world market** exists as a fallback counterparty at deliberately
  unfavourable fixed rates. It is always available, needs no diplomacy, and
  keeps a solo or isolated player playable.

#### Breaking an agreement

- Cancellation is always available and always takes effect after a fixed
  notice period (default 24 ticks, one in-game day). The other side is
  notified immediately. This is the only place a duration appears in the
  system, and it is a notice period, not an expiry.
- Cancelling costs **trust**, a public 0–100 value per nation. Cancelling a
  trade agreement costs a little; cancelling an alliance costs a lot;
  attacking a nation you hold a `non_aggression` with costs almost all of it.
- Low trust raises the acceptance threshold other nations apply to your
  proposals and is visible to everyone. Serial betrayers become diplomatically
  isolated without any rule forbidding betrayal.
- **Dead-partner rule**: an agreement with a nation that has lost its capital
  or has had no player login for 14 in-game days dissolves automatically at no
  trust cost. Without this, indefinite agreements accumulate as dead weight
  across a six-week season.

#### Alliances and other systems

- **Supply is never shared.** Allies grant transit rights, so units may enter
  each other's provinces, but every nation supplies its own units from its own
  hubs. Shared supply would require a multi-nation flow solver and it is not
  worth it.
- **Victory is alliance-aware.** The season victory condition evaluates
  alliance blocs, not individual nations. If it evaluates individuals,
  alliances become strictly self-defeating and nobody forms one.

### 6.6 Supply

The system that makes the war slow. Without it, everything degenerates into
blitz clicking.

- Supply sources: capital, plus supply hubs built in provinces.
- A province with no land path to a supply source falls back to **sea supply**
  if it is coastal and the nation holds a port on both ends. Sea supply
  consumes `convoy` equipment proportional to the demand carried and the sea
  distance.
- Compute supply throughput as a flow over the province graph. Capacity
  decreases with graph distance from the source and increases with the
  `infrastructure` level of provinces along the path.
- Units consume supply proportional to their equipment and type.
- Under-supplied units suffer attrition (equipment loss) and reduced combat
  strength.
- **Performance**: do not recompute the full supply network every tick.
  Recompute on ownership change, infrastructure change, or every 12 ticks,
  whichever comes first. Cache per-province supply level.

### 6.7 Air zones

How aircraft enter the game without unit micromanagement.

- Provinces are partitioned into air zones, roughly 15–30 provinces each.
- A player assigns wings from an air base to a zone plus a mission:
  `air_superiority`, `ground_support`, `interdiction`, `strategic_bombing`.
- Each tick, resolve air combat within a zone between opposing wings on
  `air_superiority` to produce a superiority ratio per nation.
- Superiority ratio then modifies: ground combat strength (via
  `ground_support`), enemy supply throughput (via `interdiction`), and enemy
  factory output (via `strategic_bombing`).
- The player never controls an individual aircraft. Losses are drawn from the
  fighter/bomber stockpile.

### 6.8 Naval zones

Per invariant 5, this is the **same code as air zones** with a different
mission set. Reuse the zone abstraction, the assignment UI, and the per-tick
resolution loop. If you find yourself writing a parallel implementation, stop
and generalise the air one instead.

- Water provinces are partitioned into sea zones.
- A player assigns fleets from a naval base to a zone plus a mission:
  `sea_control`, `convoy_raiding`, `convoy_escort`, `invasion_support`.
- Each tick, resolve naval combat in contested zones. Submarines are strong at
  `convoy_raiding` and weak in a stand-up fight; escorts counter them; capital
  ships decide `sea_control`.
- Air superiority over a sea zone modifies naval combat, which is why air
  resolves first.
- Effects: `sea_control` gates naval invasion and protects own convoy traffic;
  `convoy_raiding` destroys enemy convoy equipment, which cuts both their sea
  supply and their seaborne trade income; `invasion_support` grants a combat
  modifier to landings in adjacent provinces.
- **Naval invasion**: a player may order units from a coastal province to a
  hostile coastal province across a sea zone they control. Transit takes
  multiple ticks, the units are visible and vulnerable in transit, and they
  land at reduced strength. Uses upstream's existing water pathfinding.
- As with air, the player never controls an individual ship.

### 6.9 Combat

Front-based, not unit-based.

- Combat resolves at province borders where opposing controllers meet.
- Combat width per border limits how much force can engage at once, so
  numerical superiority has diminishing returns.
- Strength inputs: equipment level, supply level, air superiority, terrain,
  tech modifiers.
- Resolution is a stochastic roll per tick, seeded from
  `(worldSeed, tick, borderId)` so the tick stays reproducible from the log.
- An attack order against a nation you hold `non_aggression` or `alliance`
  with is rejected at command validation. Breaking the agreement first is a
  separate, deliberate action with its own trust cost.

### 6.10 Regent (offline AI)

**This system is load-bearing, not a convenience feature.** With a 5-second
tick and full vulnerability while offline, the regent will play the majority
of a nation's ticks. If it cannot hold a front, players do not return.

Keep the implementation simple, as specified, but make it competent at the
basics.

```ts
interface RegentConfig {
  enabled: boolean;
  focus: "economy" | "military" | "defence" | "expansion";
  marketBudget: number; // max construction points/tick it may spend
  // on the world market to cover lost imports
}
```

- Rule-based. No search, no planning, no learning.
- Runs every 12 ticks, not every tick.
- Baseline behaviour regardless of focus: keep units supplied, retreat units
  that are collapsing, keep the construction queue non-empty, assign _idle_
  military factories to a production line, keep research slots filled.
- **It must never change an existing production line's equipment type.** That
  would reset efficiency to the floor (6.2) and destroy in one decision what
  the player spent days building. Idle factories only.
- Focus only changes allocation weights:
  - `economy` — construction points to civilian factories and infrastructure
  - `military` — construction points to military factories, production toward
    ground equipment
  - `defence` — units held at owned borders, no offensive orders, production
    toward defensive equipment
  - `expansion` — offensive orders against the weakest adjacent border with
    which no agreement exists
- Naval behaviour is minimal: keep enough fleets on `convoy_escort` to cover
  active convoy demand, leave everything else where the player left it.
- **Trade fallback**: if an inbound trade flow drops to zero, the regent may
  buy the shortfall on the world market up to `marketBudget`. This is not an
  agreement and creates no obligation, so it stays within invariant 7. It is
  the only economic reaction the regent is permitted to make, and it exists
  because indefinite agreements mean an offline player can be cut off with no
  warning.
- Per invariant 7, the regent never proposes, accepts, or cancels an
  agreement, never declares war, never abandons a capital, and never orders a
  naval invasion.
- The player may leave the regent enabled while connected. Do not force it off.

---

## 7. Protocol

- Client → server: `Command` objects only. Every command is validated
  server-side against current world state before being appended to the log.
  Never trust a client-supplied cost, position, or outcome.
- Server → client: `Delta` batches and, on connect, `FullState`.
- Diplomatic state, trust values, and agreement terms are part of both. Trust
  is public to all nations; agreement terms are visible only to the two
  parties.
- Define both in `shared/protocol/` with runtime validation (zod or equivalent)
  on the server boundary.
- A client that sends malformed or unauthorised commands is disconnected, not
  silently ignored — silent failure makes debugging impossible.

---

## 8. Build phases and gates

Do not start a phase before its predecessor's gate passes. Each gate is a
demonstrable, tested state, not a code-complete state.

### Phase 0 — Fork triage

Strip lockstep from the client. Remove turn distribution, desync detection,
and the master-worker lobby. Replace with a stub server that pushes a static
hand-written world state over WebSocket.
**Gate**: the inherited renderer draws a map and territory from server-pushed
state, with no simulation running on the client.

### Phase 1 — World persistence

Tick loop at 5s. Postgres schema, command log, snapshot every 60 ticks,
restore-on-startup, advisory lock. Reconnect returns correct state.
**Gate**: kill the server container mid-run; it resumes at the correct tick
with no lost commands.

### Phase 2 — Province graph

Generate the province partition over the existing tile map. Ownership
derivation, adjacency, terrain, infrastructure, resource deposits, air and sea
zone membership. Render province borders as an overlay.
**Gate**: a province changes hands, ownership propagates from tiles, and the
client renders it correctly.

### Phase 3 — Factories and construction

Building slots, all factory types including dockyards and refineries,
construction queue, construction points, resource extraction and consumption.
**Gate**: a player can queue a factory, watch it build over ticks, and see it
increase output. Resource shortage degrades output proportionally.

### Phase 4 — Production and equipment

Production lines, efficiency ramp and reset-on-switch, stockpile accumulation,
units drawing equipment, losses destroying equipment, strength scaling.
**Gate**: a sustained fight visibly drains a stockpile and weakens units.
Switching a production line visibly costs the player output for a long time.

### Phase 5 — Research

Slots, tech list with prerequisites, modifiers, equipment tier unlocks.
**Gate**: a completed tech measurably changes a production or combat number.

### Phase 6 — Supply

Supply hubs, flow computation over the province graph, caching and recompute
triggers, attrition and combat penalties. Land supply only; the sea supply
path is stubbed until Phase 9.
**Gate**: an overextended offensive stalls from supply alone, without enemy
action. Full supply recompute stays under 50ms on the largest map.

### Phase 7 — Diplomacy and trade

Agreement types, proposal and acceptance flow, indefinite persistence, notice
period on cancellation, trust, dead-partner dissolution, world market,
per-tick trade flows in construction points. Land routes only.
**Gate**: two nations hold a trade agreement across a season restart, with no
renewal action from either player. Breaking it costs the visible trust the
spec says it should, and the other side is notified before the flow stops.

### Phase 8 — Air zones

Zone partition, air bases, wing assignment, missions, per-tick air combat
resolution, superiority effects on ground combat, supply, and production.
**Gate**: air superiority in a zone measurably shifts a ground battle there.

### Phase 9 — Naval zones and convoys

Sea zone partition, naval bases, fleet assignment and missions, naval combat
resolution. Activate convoy consumption in both sea supply and seaborne trade.
Convoy raiding, naval invasion over upstream's water pathfinding.
**Gate**: cutting an opponent's convoy routes starves an overseas province of
supply _and_ cuts their trade income, without any land engagement. A naval
invasion successfully lands and holds a beachhead.

### Phase 10 — Regent

Focus config, allocation weights, baseline competence behaviours, idle-factory
rule, world market trade fallback.
**Gate**: a nation left under regent control for 2,000 ticks against an active
opponent still holds its capital, has a non-empty construction queue, and has
not reset a single production line.

### Phase 11 — Accounts and identity

Until here a session says which nation it is and the server believes it: the
nation comes from `?nation=` in the URL, there is no credential of any kind,
and two sessions may hold the same nation at once. That was a deliberate
deferral through phases 0 to 6, when the worst it bought an impostor was
somebody else's construction queue.

**Phase 7 made it load-bearing.** §7 promises that a trade agreement's terms
are visible only to the two parties, and that promise cannot be kept by a
server that cannot tell who is asking. Worse, an impostor may cancel that
nation's agreements — spending trust it can never earn back, and stopping a
flow its real player was relying on. A guarantee the code cannot enforce is not
a guarantee.

Accounts, sessions bound to accounts, and a nation claimed by exactly one
account for the life of a season. Reconnecting resumes the same session rather
than opening a second one. Registration is deliberately minimal — this is a
hobby world, not a service — but it is a real credential and it is checked on
every `hello`.

This also answers §10's "how new players enter a world already in progress",
because entering is now a thing that happens to an account rather than to a
URL.

**Gate**: a session that claims a nation it does not hold is refused, and is
sent nothing about that nation. Two browsers signed in to the same account
share one nation and one session; two accounts cannot hold the same nation.
The refusal survives a world restart.

### Phase 12 — Deployment

Docker Compose, nginx vhost with WebSocket upgrade, an in-stack backup sidecar,
and a systemd watchdog that pushes an alert when the world stops ticking.

_Three things the deployment environment is likely to get wrong, and did on
the machine this world runs on. Verify each on yours rather than assuming:_

- _Whatever backup mechanism the host "already has" may not exist. Prefer a
  backup sidecar inside this stack (nightly `pg_dump`, integrity check as a
  hard abort, rotation) — a stack that carries its own backup moves with you.
  And test a restore once, before it matters._
- _A monitoring system elsewhere on your network may not be reachable from the
  world server. Check before relying on it. A systemd watchdog on the host
  plus a push alert is the fallback that always works._
- _Port 443 may not be an HTTP server. If a `stream`/SNI block owns it, an
  http-context `listen 443` passes `nginx -t` and then fails the **reload**
  with "still could not bind()" — while systemd reports success and the old
  config keeps serving. After every reload, prove the socket is really
  listening instead of trusting the exit code._

**Gate**: a world runs uninterrupted for seven days on the deployment host,
with snapshot restore verified at least once.

_Deployment is last on purpose, and phase 11 is why: a world reachable from
outside with no accounts in front of it is a world in which anybody is
everybody._

---

## 9. Conventions

- TypeScript strict mode. No `any` in `shared/` or `server/systems/`.
- Simulation systems must be free of I/O, wall-clock reads, and
  `Math.random()`. All randomness comes from a seeded PRNG derived from
  `(worldSeed, tick, contextId)`.
- Every balance number lives in `shared/config/`, never inline in a system.
- Every system gets a unit test that runs it over a fixture world for N ticks
  and asserts invariants (no negative stockpiles, no resource creation, no
  orphaned provinces, no agreement referencing a dissolved nation).
- Add a test per design invariant in section 2 where it is mechanically
  checkable — for example, assert that no system emits an event that sets a
  value to zero as a block rather than scaling it down.
- Migrations via Drizzle. Never edit a shipped migration.
- Conventional commits. Reference the phase number in the commit body.

## 10. Known open questions

Flag these when they become blocking rather than deciding them early:

- Season victory condition specifics, evaluated over alliance blocs
- Manpower model — conscription laws, or a simple population-scaled cap
- How new players enter a world already in progress
- Whether occupied provinces produce at reduced rate or not at all
- Whether ships are hull-and-module designed or just three fixed types
- Whether trade agreements can carry equipment as well as resources

**Deliberately excluded, with reasons:**

- _Economy laws and consumer goods._ This is the obvious next HoI4 economic
  lever, but it only works if it is gated by something — political power,
  stability, war support — and none of those systems exist here. Ungated it is
  a free lunch, and adding a politics layer to gate it would touch nothing else
  in the game. It fails invariant 6.
- _Division templates and equipment designers._ Adds a design minigame that
  does not interact with any other system on this list.
- _Faction-level diplomacy (multi-party pacts)._ Bilateral agreements plus
  alliances cover the need at a fraction of the state complexity.
