# Handover — state of the work

**Written 2026-08-31.** Read this first if you are picking the project up
without context. It says where the work stands, what to do next, and which
traps have already been paid for.

- **What this project is:** [`README.md`](README.md)
- **The design, in full:** [`CLAUDE.md`](CLAUDE.md) — every system, the 11 build
  phases, and the gate each has to pass
- **Why things are the way they are:** [`docs/decisions/`](docs/decisions/)
- **How the code works right now:** [`docs/architecture/`](docs/architecture/)

---

## Where we are

**Phase 10 of 13 — the regent is gated (2026-09-01, afternoon).** Eleven of
thirteen gates. Phase 10 landed after the morning's phase 9: `RegentConfig`
in the state (hash version 4), `configure_regent` on the wire (protocol 14,
with the regent's controls in the economy panel), and `systems/regent.ts` —
every 12 ticks, rule-based, garrisoning the capital, keeping the queue
non-empty, running rifles _and_ guns (the worst-ratio lesson), filling
research, buying the scarcest resource at the market inside its budget, and
never once touching an existing line's equipment type. **It is opt-in until
phase 11** (decision 0018): until accounts exist, a default-on regent plays
all fifty-two nations and every gate measures the regent instead of its
subject. The gate transcript is under "Phase 10 — the regent" below; its
counter-proof lost the same capital in 102 ticks that the regent held for
2,000.
Four pieces landed in the night and morning of 2026-08-31/09-01, all planned
in "The plan, end to end" and all gated:

- **The state-hash check holds within a hash version** (decision 0016, Max's
  call answering the open question below): `STATE_HASH_VERSION` rides in every
  snapshot, a cross-version restore loads loudly instead of dying as
  "damaged", and a season can now survive a deploy that touches the state.
- **The front is a rate, tile by tile** (plan item 1). `AttackOrder` carries
  `progress`; `combat.ts` moves it per tick out of the same strength
  comparison — `FRONT_ADVANCE × (pressed − defence) / (pressed + defence)`,
  the roll varying the rate — and empty ground is marched into at
  `FRONT_MARCH_ADVANCE` (an eighth, exactly: eight additions reach 1.0 with no
  float residue). A battle costs equipment every tick; a march costs nothing.
  Cancelling loses the progress, so a front cannot be banked. The wire went
  11 → 12: `attacks` carries progress and a public `fronts` list rides every
  full state and delta, because the defender and every spectator paint the
  partial progress as tiles — `FrameAdapter` orders a contested province's
  tiles by BFS from the attacking border and colours the first
  `progress × tileCount` of them. The phase-4 gate now proves the course
  ("progress seen strictly between 0 and 1, largest one-tick step ≤ the march
  rate") with a `--break=lump` counter-proof; the phase-8 gate measures how
  _deep_ the same front grinds in a fixed window with and without bombers,
  fought twice over the same provinces since cancel-resets-progress makes
  that fair.
- **Phase 9, gated on 2026-09-01.** `scripts/phase9-gate.mjs` passes on a
  fresh world (transcript under "Phase 9 — naval zones and convoys" below)
  and `--break=moored` fails at the checks it aims at. The systems:
  No `provinces.bin` bump: the sea routes over the sea-zone graph derived at
  load (decision 0017), which deleted the plan's riskiest step. What runs:
  the three ship types as `FORMATIONS` rows; `systems/naval.ts` on the same
  zone machine as the air war (attrition, stand-down, convoy sinking with
  `ESCORT_COVER` as §6.8's counter); sea supply between ports — §6.6's "port
  on both ends" — priced in convoys, floored at `SEA_SUPPLY_FLOOR`, cut but
  never severed by raiders; seaborne trade as a fourth `min`-term in
  `scaleOf` with the importer finding the convoys, and the route asked every
  tick (`systems/routes.ts` — land free, sea priced, none moves nothing);
  convoy wear in both consumers; and `naval_invade` — transit over the zone
  path at half a day a zone, publicly visible (`invasions` on every full
  state and delta), landing at `INVASION_LANDING_FACTOR` on an open beach,
  turned back by a garrison raised during the crossing. The wire went
  12 → 13. STATE_HASH_VERSION is 3. `tests/server/Naval.test.ts` (12),
  `tests/shared/SeaGraph.test.ts` (4) and the two-island fixture hold it
  all.
- **A menu instead of six open panels** (plan item 2): an icon bar top-left,
  one panel at a time, forms keep their identity across switches, the
  province panel stays on the right. `tests/client/world/HudMenu.test.ts`
  holds the rules; how it _looks_ is the morning checklist's first item.

The paragraphs below describe the state as of phase 8's gate and are still
accurate about everything they cover.

**Phase 8 of 13 — air zones, and §6.9 underneath it.** The ground combat
phase 8's gate needs to shift now exists: `claim_province` is a standing attack
order, resolved every tick against equipment, supply, terrain and combat width
with a roll seeded from `(worldSeed, tick, province)`. The border drift is gone
and an unattended world is quiet until phase 10 — decision 0014 has the whole
argument. Every gate that leaned on the drift has been rebuilt around a war it
starts itself, and the board is green again.

**Phase 8 is gated.** Its gate passes and its counter-proofs fail where they
should: without bombers the line held the whole 40-tick window and lost
nothing; with bombers over it the same army at the same strength took both
provinces in 1.5 ticks. The transcript is under "Phase 8 — air zones" below.

The rest of this section describes what was built.

**Phase 8's code**: 567 tests, typecheck strict, lint,
build-prod. One `Formation` entity serves wings and fleets alike, and
`systems/zones.ts` is the machine §6.8 says phase 9 must reuse — what differs
between a fighter wing and a submarine flotilla is a row in
`shared/economy/Formations.ts`, not a branch in a system. The three effects
§6.7 lists landed on systems that already existed: `ground_support` on the
multiplier `combat.ts` had been holding a place for, `interdiction` on
`supplyReach` where reach is computed, `strategic_bombing` on factory output.
Wire went 10 → 11.

`fighter` and `bomber` had been produceable since phase 4 and consumed by
**nothing** — a nation could fill a warehouse with aircraft that did not exist
as far as the rest of the game was concerned. That is the hole this closed.

Its gate is done too, and what it cost to get there is under "What the phase-8
gate kept getting wrong" — five rewrites, each of which turned out to be about
the game rather than about the script.

Phases 0 to 7 have their gates demonstrated
against the code as it stands, counter-proofs and all. Two of them went green
on 2026-08-31: phase 6, whose gate needed three things this file had not
predicted ("What the phase-6 gate was really asking" below), and phase 7,
which is the whole of §6.5 — agreements, trust, the world market, and the first
code in this project that makes invariant 3 mean anything.

The world has an economy, an industry, an army and a supply line. Provinces
extract from their deposits; civilian factories make construction points;
military factories and dockyards draw the materials of **whatever their
production line is making**, so a tank line and a rifle line of the same size
are not the same drain on the same mines. Lines climb an efficiency ramp over
about 38 in-game days and are thrown back to the floor the moment their
equipment type changes. Equipment goes into a national stockpile, divisions
draw it out, and a border clash destroys it. Research moves the rates all of
that reads. And supply decides how much of it reaches a division standing at
the end of a long front — which is the system that makes the war slow.

A shortage anywhere scales every consumer down together instead of stopping
anything. That is invariant 2, end to end, and it is what phase 3's gate
measures.

There is a HUD: economy, construction queue and province panel from phase 3,
and now a production screen and a research screen.

**Start it with three commands:**

```bash
docker compose up -d # Postgres + the world, ws://localhost:3000/ws
npm run start:client # http://localhost:9000 (add ?nation=1 to play one)
curl -s localhost:3000/health
```

Without `docker compose`, `npm run start:server` still works: with no
`DATABASE_URL` the world keeps its history in memory and says so on the first
line.

## The plan, end to end

**This section is written to be worked through without asking anybody
anything.** Every design question §10 left open has an answer now (it is in
CLAUDE.md §10, with reasoning), so what follows is nine pieces of work in
order, each with what to build, which files it touches, what it has to prove
before it counts as done, and the traps that are already known.

Read the two rules the project runs on before starting any of it:

1. **A phase is done when its gate has been demonstrated, not when it
   compiles.** Every gate is a script that plays a real world over a WebSocket
   and prints what it measured.
2. **A gate that has never failed has proved nothing.** Every one of them
   carries `--break=` counter-proofs that disable the mechanic it measures, and
   each must fail _at the check it aims at_ — not at an earlier one. Phase 4
   shipped a counter-proof that failed for the wrong reason and it took a
   rewrite to notice.

### Order, and why this one

Two pieces of work come before the remaining phases, at the player's own
request after seeing the game run:

The **front, tile by tile** goes first because it is not a feature but a
repair. Taking a province is currently the only lump sum left in the game —
`combat.ts` rolls once a tick and the province flips or does not — and
invariant 1 forbids exactly that. It also touches `combat.ts` at its core,
which the phase-4 and phase-8 gates both measure, so doing it _before_ writing
more gate saves writing them twice.

The **menu** goes second because it is cheap and because six panels covering
half the map is the first thing anyone notices.

Then phases 9 to 12 in CLAUDE.md's own order, then the map's borders.

---

### 1 · The front, tile by tile

**Done 2026-09-01 (commit `8ef82a66`), exactly as planned below** — with two
deviations worth knowing: the march into empty ground is `1/8` a tick (binary
exact, so eight additions reach 1.0 with no float residue), and the client
paints through `FrameAdapter`'s `tileState` rather than a map layer, because
`MapLayerPass` uploads its texture once and draws _under_ the territory fill.
A march costs no equipment; only a battle does. The phase-4 gate carries the
gradual-front checks and `--break=lump`; the phase-8 gate now measures front
_depth_ in a fixed window (20.9% without air, 27.1% with bombers).

**What it is.** A standing attack gets a _progress_ value. Each tick it grows
by an amount derived from the same strength comparison `combat.ts` already
makes, and shrinks when the attacker is losing. The province changes hands when
progress completes. The client paints partial progress as tiles taken from the
attacking border inward, so a contested province visibly fills up.

**Why it is right.** Invariant 1: everything is a rate. Invariant 8 stays
intact — the player still orders provinces, and tiles remain rendering only.
And it makes combat _simpler_ than the current all-or-nothing roll.

**Server.**

- `AttackOrder` in `world/WorldState.ts` gains `progress: number` (0..1).
- `systems/combat.ts`: instead of `pressed > defence` deciding the province,
  compute `advance = f(pressed, defence)` — positive when the attacker is
  ahead, negative when behind — and emit `attack_progressed`. Keep the seeded
  roll: it varies the rate, it no longer flips a coin. Emit `control_changed`
  only when progress reaches 1.
- New event `attack_progressed`, a case in the reducer, and the field in
  `snapshot()`, `restoreFrom()` (optional, `?? 0`) and **`stateHash()`**.
- `shared/config/combat.ts`: one constant for how fast a front moves at parity.
  Tune it so an even fight takes in-game _days_, not ticks — this is the number
  that decides whether the war feels slow, and §6.9 wants slow.

**Client.**

- Wire: the economy view's `attacks` becomes `{ province, progress }[]`, and
  provinces under attack by _anyone visible_ need progress on the wire too, or
  a defender cannot see themselves being ground down. Bump `PROTOCOL_VERSION`.
- Rendering: a province's tiles ordered by distance from the attacking
  border — a BFS over the tile grid from the tiles adjacent to the staging
  province, computed client-side from `ProvinceTileIndex`. Take the first
  `progress × tileCount` of them in the attacker's colour. The province-border
  map layer (`ProvinceBorders.ts`) is the pattern to copy; it needs no new
  WebGL pass.

**Gate.** Extend `scripts/phase4-gate.mjs` rather than adding a script: order
an attack, watch `progress` rise over many ticks without the province
changing hands, then watch it complete. `--break=` a version where progress
jumps to 1 in one tick — the check that has to fail is "the front moved
gradually", and a lump sum must not pass it.

**Traps.** The state hash change makes every running world unstartable
(`docker compose down -v`). Progress must be _lost_ when an attack is called
off, or calling off and re-ordering becomes a way to bank progress for free.

---

### 2 · A menu instead of six open panels

**Done 2026-09-01 (commit `671c71e7`)** — icon bar, one panel at a time,
forms keep their identity across switches. Nobody has seen it in a browser
yet; that is item 0a of the morning checklist.

**What it is.** An icon bar at the top left — economy, construction,
production, research, diplomacy, air — opening one panel at a time. The
province panel stays where it is, because it is a response to a click on the
map.

**Where.** `client/world/ui/Hud.ts` only. The panels are already built as pure
functions of the model and already have their own `hidden` flag; what changes
is who sets it. Keep the diplomacy and air _forms_ built-once (they hold what
the player is typing) and only toggle visibility.

**Traps.** `#world-hud` needs its `z-index` (it was invisible under the canvas
for three phases — see "What the browser found"). Icons: no asset pipeline is
needed, the HUD is plain DOM and a glyph or inline SVG is enough.

**Done when** a person opens the game and can see the map. There is no script
for this, and that is the point.

---

### 3 · Phase 9 — naval zones and convoys

**The machine already exists.** `systems/zones.ts` resolves any zoned system;
what phase 9 adds is data and a thin resolver, exactly as
[decision 0015](docs/decisions/0015-one-formation-and-one-zone-machine.md)
planned. If you find yourself writing a second resolver, the mistake was made
in phase 8 and this is where it shows.

**Steps.**

1. **Water provinces.** ~~A `provinces.bin` format bump~~ — **not built, and
   deliberately** ([decision 0017](docs/decisions/0017-the-sea-graph-is-the-zone-graph.md)):
   everything the sea's consumers ask for — zone adjacency, distance, a path —
   is a property of the sea zones the artefact already stores per tile, so
   `src/shared/map/SeaGraph.ts` derives the graph at load the way
   `borderTiles` is derived, and the format stays at 1. This deleted the
   phase's riskiest step.
2. **The ship types**, as three rows in `FORMATIONS`: `submarine_flotilla`,
   `escort_group`, `battle_fleet`, all `kind: "naval"`, `base: "naval_base"`,
   with the weight table §6.8 describes in words — submarines strong at
   `convoy_raiding` and weak at `sea_control`, escorts the counter, capital
   ships deciding `sea_control`. The equipment types already exist.
3. **`systems/naval.ts`**, the mirror of `air.ts`: attrition in contested
   zones, formations sent home when their naval base is lost. It applies no
   effects, for the same reason `air.ts` applies none.
4. **Convoys become real.** `convoy` equipment is consumed by sea supply and by
   seaborne trade, and destroyed by `convoy_raiding`. Sea supply is stubbed in
   `supply.ts` and this is what un-stubs it. A trade route that crosses water
   consumes convoys — `trade.ts` currently refuses such routes, and that
   refusal is what phase 9 replaces.
5. **Naval invasion**: units ordered from a coastal province to a hostile one
   across a sea zone the nation controls, in transit for several ticks, landing
   at reduced strength. Upstream's water pathfinding is the four files that did
   not survive phase 0 (`PathFinder.ts`, `.Air`, `.Station`,
   `spatial/SpatialQuery`); this is their real consumer.
6. **Client**: the air panel's assignment form takes a zone _kind_, so it
   serves both. That is the invariant-5 test in the UI.

**Gate** (`scripts/phase9-gate.mjs`) — **passed 2026-09-01**, transcript
under "The gates, run rather than described". The staging notes below are
kept because they are what the gate had to learn:

1. Stage two coastal nations with no land route between their measured parts
   (or use an overseas beachhead: control a far coastal province, port both
   ends — `supplyReach` then reads it per division on the wire).
2. Convoys exist only through production: a dockyard line on `convoy`. A
   fresh nation has none, and sea supply then sits at `SEA_SUPPLY_FLOOR` —
   stage the convoys first or the cut has nothing to cut.
3. The starvation half: a garrison on the far shore reports its supply on
   the wire; enemy `submarine_flotilla`s on `convoy_raiding` over the route
   zone must drop it (SEA_RAID_SUPPLY_MAX caps the direct cut at 25%, and
   the sinking compounds it as the stock drains). Never to zero — the floor
   is the counter-proof of invariant 2.
4. The trade half: a standing sea trade (propose/accept works across water
   now); the same raiders must visibly drop the seller's points income —
   `tradePointsIn` is on the wire.
5. The landing: `naval_invade` an open hostile beach across a controlled
   zone; the transit shows in the public `invasions` list; after
   `zones × INVASION_TICKS_PER_ZONE` ticks the province's controller flips
   and holds. Raise the garrison first in a second run and the same landing
   must turn back — that is a counter-proof the mechanic hands you for free.
6. `--break=moored`: the raiders never sail. Must fail at the starvation
   check, not earlier.

Traps already known: WORLD_TICK_MS through any compose restart; sweep your
own leftovers (transits too); production stood down during measurement
windows; `ps -eo pid,etimes` before calling a run stuck. And one new one:
**a beachhead on the partner's island is a land route** — the trade-route
BFS starts from every controlled province, so a gate that stages both a
beachhead and a sea trade between the same pair is measuring a land trade.

**Traps.** Everything the phase-8 gate learned applies: supply hubs before
armies, production stopped during a measurement window, and time the fight
rather than counting it. Sea supply must degrade, never sever (invariant 2) —
a province with no convoys is badly supplied, not cut off.

---

### 4 · Phase 10 — the regent

**Done 2026-09-01, gated** — see the transcript above and decision 0018 for
the two calls the specification left open (opt-in until phase 11; the
baseline translated for divisions that cannot move). Everything below was
the plan it was built to.

**Load-bearing, not a convenience.** With a five-second tick, the regent plays
most of a nation's ticks. If it cannot hold a front, players do not come back.

**Build** `systems/regent.ts`, running every 12 ticks, rule-based, no search.
Baseline regardless of focus: keep units supplied, retreat collapsing ones,
keep the construction queue non-empty, assign _idle_ military factories to a
line, keep research slots filled. `RegentConfig.focus` only changes allocation
weights.

**The one rule that matters most**: it must **never** change an existing
production line's equipment type. That resets the efficiency ramp to the floor
and destroys in one decision what a player spent days building. Idle factories
only.

Per invariant 7 it never proposes, accepts or cancels an agreement, never
declares war, never abandons a capital, never orders a naval invasion. Its one
economic reaction is the world market, up to `marketBudget`, when an inbound
trade flow drops to zero.

**Gate**: a nation under regent control for 2,000 ticks against an active
opponent still holds its capital, has a non-empty construction queue, and has
not reset a single production line.

**Trap.** The regent will be the first thing that plays the game as a whole.
Expect it to find every mechanic that only works when a human is watching.

---

### 5 · Phase 11 — accounts and identity

**Why it is a phase.** Since phase 7 a session can claim any nation in its
`hello`, read that nation's treaty terms and cancel its agreements. §7 promises
terms are visible only to the two parties, and a server that cannot tell who is
asking cannot keep that promise
([decision 0013](docs/decisions/0013-identity-is-a-phase-not-a-deferral.md)).

**Build**: accounts, sessions bound to accounts, and a nation claimed by
exactly one account for the life of a season. Reconnecting resumes the same
session rather than opening a second. Registration is deliberately minimal —
this is a hobby world — but it is a real credential, checked on every `hello`.

**New players take a nation no account holds** (§10), inheriting whatever the
regent built. That is what makes a persistent world joinable in week five.

**Gate**: a session claiming a nation it does not hold is refused and is sent
nothing about that nation. Two browsers on one account share one nation and one
session; two accounts cannot hold the same nation. The refusal survives a
world restart.

**Trap.** Deployment already happened, so the world is currently reachable with
no accounts in front of it. Until this ships, treat the deployed world as a
demo rather than a season.

---

### 6 · Phase 12 — deployment, properly

Most of it is done and documented in `docs/deploy/README.md`, and the
host-specific half is in the git-ignored `HOST.local.md`. What is left:

- **TLS and a hostname.** Needs a DNS record; the zone is on Cloudflare and no
  API token exists on the machines, so this needs a token with `DNS:Edit` or
  somebody clicking it. The ACME vhost is already in place.
- **A backup sidecar inside the stack** — nightly `pg_dump`, an integrity check
  as a hard abort, rotation. A stack that carries its own backup moves with
  you. **Test a restore once, before it matters.**
- **A watchdog** that alerts when the world stops ticking. Do not assume a
  monitoring system elsewhere can reach this host.

**Gate**: seven uninterrupted days on the host with one verified snapshot
restore.

---

### 7 · The victory system

Currently `planned("victory")` in the system list. §10 now specifies it: an
alliance bloc holding **40% of all provinces for 7 in-game days** wins
outright; otherwise the season ends after **six weeks** and the highest score
wins (provinces, industry, trust). Blocs, not nations — evaluating individuals
makes alliances self-defeating.

Needs bloc resolution over the agreement graph (an alliance is transitive for
victory purposes, or it is not — decide and write it down), a held-for counter
in the world state, and an end-of-season archive path.

---

### 8 · Real country borders

The player's standing request, and the reason is worth understanding before
starting: `ProvincePartition.ts` grows each nation outward from its capital
over land until the regions meet, then Lloyd relaxation evens the sizes. That
gives the right neighbours around the right capitals with the wrong outlines —
and _deliberately equal_ sizes, which is the third thing that looks wrong.

**Wanted**: real outlines, distinguishable colours, and unequal sizes.

Natural Earth's admin-0 boundaries are public domain and the standard source.
The work is a projection onto the tile grid, a rasterisation into
province→nation assignment, and coasts and islands. The nation list itself is
fine — the manifest already carries real names, flags and capitals.

**It invalidates every running world**, because the partition is in the map
hash. Plan it together with a season boundary.

---

### 9 · The standing checklist for any phase

Before calling anything done:

```bash
npm run test                          # 609 at the end of phase 10
TEST_DATABASE_URL=... npm run test:db # skipped silently without it
npx tsc --noEmit -p tsconfig.strict.json
npm run lint
npm run build-prod
node scripts/check-doc-links.mjs
```

Then the gate, on a world at `WORLD_TICK_MS=50`, plus its counter-proofs. Then
the documents: `HANDOVER.md` (state), `docs/architecture/README.md` (how it
works), a decision record if a choice was made that a later reader would
otherwise have to reconstruct, and `README.md` if the phase count moved.

**And once per phase, open the browser.** Everything in this project is proved
by a script except the client, and on 2026-08-31 that gap turned out to be
hiding three bugs at once — a HUD that had been invisible under the map for
three phases among them. A gate cannot tell you the game is unplayable.

---

## The whole plan, and how far along it is

Eleven of thirteen gates passed. **The gate is the unit of progress here, not the
code:** a phase is done when its gate has been demonstrated, not when it
compiles.

| Phase                          | Gate                                                                                | State                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 0 · Fork triage                | The inherited renderer draws a map from server-pushed state, no client simulation   | ✅ passed                                                          |
| 1 · World persistence          | Kill the container mid-run; it resumes at the correct tick with no lost commands    | ✅ passed                                                          |
| 2 · Province graph             | A province changes hands, ownership propagates from tiles, the client renders it    | ✅ passed server-side; the rendering half is the morning checklist |
| 3 · Factories and construction | Queue a factory, watch it build over ticks, see output rise; shortage degrades it   | ✅ passed                                                          |
| 4 · Production and equipment   | A sustained fight drains a stockpile; switching a line costs output for a long time | ✅ passed                                                          |
| 5 · Research                   | A completed tech measurably changes a production or combat number                   | ✅ passed                                                          |
| 6 · Supply                     | An overextended offensive stalls from supply alone; full recompute under 50 ms      | ✅ passed                                                          |
| 7 · Diplomacy and trade        | A trade agreement survives a season restart with no renewal from either player      | ✅ passed                                                          |
| 8 · Air zones                  | Air superiority in a zone measurably shifts a ground battle there                   | ✅ passed                                                          |
| 9 · Naval zones and convoys    | Cutting convoy routes starves a province _and_ cuts trade income, with no land war  | ✅ passed                                                          |
| 10 · Regent                    | 2,000 ticks under regent control against an active opponent, capital still held     | ✅ passed                                                          |
| 11 · Accounts and identity     | A session claiming a nation it does not hold is refused and told nothing about it   | ⬜                                                                 |
| 12 · Deployment                | Seven uninterrupted days on the deployment host, one verified snapshot restore      | ⬜                                                                 |

---

## The gates, run rather than described

All of them against `WORLD_TICK_MS=50 docker compose up -d --build` on a world
created fresh for the run (`docker compose down -v` first).

### Why they need a faster clock

A civilian factory is 360 construction points; an efficiency ramp is 900 ticks;
`machine_tools` is 480; attrition is two percent a tick. At five seconds a tick
these gates would run for hours. The override is not a hack bolted on for
testing: §8's phase-10 gate asks for 2,000 ticks under regent control, which is
two hours and forty-seven minutes of wall clock at the real rate. Nothing in
the simulation depends on the interval — the schedule is anchored to the tick
(decision 0003) and every rate is per tick — so a faster clock runs the same
world sooner rather than a different world. `/health` reports `tickMs`, and
every gate refuses to run above its own threshold with instructions rather than
a timeout.

**A fresh world starts with zero manpower**, which regrows at 0.02% of the cap
a tick, so nothing can raise a division for the first couple of thousand ticks.
Give a new world two minutes at 50 ms before running phase 4 or 6.

### Phase 10 — the regent

```
phase-10 gate
  world world-0 at tick 1988, 50 ms a tick
  nation 7 is left to its regent; nation 43 marches on its capital in province 63, 5 hop(s) behind the border
  the regent takes over: defence, half a point a tick for the market
  ok    the opponent was active: 13 standing attacks ordered across the window
  ok    the capital in province 63 is still the regent's after 2000 tick(s)
  ok    the construction queue is non-empty now and was on 99 of 100 samples
  ok    1 production line(s) ran and not one was reset — the ramp is the player's days of work, and the regent spent none of it
  ok    the regent raised its garrison (1 division(s) on the roster)
  ok    and put the research slots to work
  ok    the world stayed healthy throughout (0 ms behind at tick 3992)
PASS
```

**The opponent needs no army, and that is the measurement.** Since the front
became a rate, `claim_province` marches into any undefended province — so a
relentless attacker takes everything nobody is standing in, and the regent's
one capital garrison is exactly what turns the march into a battle that
nothing cannot win. The counter-proof is the same offensive against a
sleeping steward:

```
phase-10 gate
  world world-0 at tick 4445, 50 ms a tick
  running with --break=asleep: this must FAIL
  nation 15 is left to its regent; nation 44 marches on its capital in province 153, 5 hop(s) behind the border
  --break=asleep: the regent never wakes
  ok    the opponent was active: 10 standing attacks ordered across the window
  FAIL  the capital in province 153 is still the regent's after 102 tick(s)
  FAIL  the construction queue is non-empty now and was on 0 of 6 samples
  FAIL  0 production line(s) ran and not one was reset — the ramp is the player's days of work, and the regent spent none of it
  FAIL  the regent raised its garrison (0 division(s) on the roster)
  FAIL  and put the research slots to work
  ok    the world stayed healthy throughout (0 ms behind at tick 4548)
FAIL
```

The capital fell in 102 ticks — five empty provinces at eight ticks a march —
and every regent-shaped check went red behind it, with the active-opponent
check before them still green.

### Phase 9 — naval zones and convoys

```
phase-9 gate
  world world-0 at tick 5918, 50 ms a tick
  nation 17 (an island) faces nation 7's coast at province 56, over sea zone 11 — enemy, trade partner and raider in one, as a war across a strait tends to make you
  island: 3 dockyard(s) queued against 35 coastal province(s)
  defender: 3 dockyard(s) queued against 16 coastal province(s)
  making 40 convoys and 20 submarines...
  ok    the island holds 135 convoys and the defender 20 submarines — all of it dockyard time (§6.3)
  the defender sells aluminium; the island has room for it
  ok    a trade across open water is offerable now (accepted)
  ok    the sea trade moves: 0.500 aluminium a tick arrives on the island's convoys
  flotillas over shared sea zone(s) 11: the island's convoys are being hunted (trade-window)
  ok    raiding the route cut the trade income: 0.500 -> 0.460 aluminium a tick, with no land engagement
  ok    the convoys themselves are being sunk: 1.70 lost under the raid against 0.16 to wear alone in the same window, with the yards silent
  ok    the invasion put to sea (accepted)
  ok    the crossing is on the wire for everyone — a spectator can watch it coming, which is the §6.8 defence
  ok    the crossing took 11 tick(s) — an operation, not a teleport (12 a zone)
  ok    the beach at province 56 is the island's beachhead now
  ok    the beachhead is supplied over the sea: 100.0% — above the no-convoy floor of 25%, so the convoys are carrying it
  flotillas over shared sea zone(s) 11: the island's convoys are being hunted (supply-window)
  ok    raiding the route starved the beachhead: supply 100.0% -> 92.0%
  ok    and never to nothing — a cut convoy line is a worse one, not a severed one (invariant 2)
  ok    and the beachhead held through all of it
  ok    the world stayed healthy throughout (0 ms behind at tick 8268)
PASS
```

**The order inside the gate is the finding.** The trade half is measured
_before_ the landing, deliberately: a beachhead joins the two landmasses, the
route resolver then rightly calls the pair a land route, and a land trade
needs no convoys and fears no submarine. Three runs paid for that sentence —
the flow sat at exactly 0.500 under a full raid until the windows were
reordered. The raiders also go home for the crossing, because §6.8 gates an
invasion on sea control and the gate demonstrates the rule by obeying it, and
come back out for the starvation window.

**The sinking check found a real bug before it was sharp.** Its first version
passed whenever the convoy stock fell at all — and the stock always falls,
because wear thins it with no enemy anywhere. Under `--break=moored` it went
green on wear alone, which exposed two things at once: the check could not
tell wear from war, and `naval.ts` priced a trade route's exposure at
`zones × rate` — zero for a route inside one shared zone, so the raiders had
in fact sunk nothing. The pricing now matches the trade system's
(`CONVOYS_PER_TRADE_FLOW_ZONE × rate × max(1, zones)`,
`tests/server/Naval.test.ts` holds the regression), and the check measures a
quiet window first and demands the raid empty the warehouse at better than
twice the wear rate: 1.70 lost under the raid against 0.16 to wear.

**What the earlier runs taught, each on a fresh world:**

- The first candidate island had one coastal province, already full — the
  stage search requires three now, and takes the biggest shore on offer.
- Submarines drink oil, and a defender picked for its coastline may pump
  none: nation 7 sat at sufficiency 0.000 with a full steel store. The gate
  buys the oil on the world market — §6.5's answer for exactly this nation —
  and stops the order the moment the boats are built, because the standing
  order was eating the construction budget the raiders' harbour needed.
- The trade resource is chosen at run time, one the seller holds and the
  buyer has room for: on a world a few hours old, steel sits at RESOURCE_CAP
  and the intake scale is zero (the phase-7 trap, paid for again).
- **Every rerun needs a fresh world** (`docker compose down -v`): the
  previous run's beachhead joins the island to the mainland, `findStage`
  then finds no "across", and the trade route resolver reads land.

**And it was checked against itself being broken**, on its own fresh world —
failing at the three checks that measure the raid and at none before them:

```
phase-9 gate
  world world-0 at tick 5956, 50 ms a tick
  running with --break=moored: this must FAIL
  nation 17 (an island) faces nation 7's coast at province 56, over sea zone 11 — enemy, trade partner and raider in one, as a war across a strait tends to make you
  island: 3 dockyard(s) queued against 35 coastal province(s)
  defender: 3 dockyard(s) queued against 16 coastal province(s)
  making 40 convoys and 20 submarines...
  ok    the island holds 134 convoys and the defender 20 submarines — all of it dockyard time (§6.3)
  the defender sells aluminium; the island has room for it
  ok    a trade across open water is offerable now (accepted)
  ok    the sea trade moves: 0.500 aluminium a tick arrives on the island's convoys
  --break=moored: the flotillas stay in harbour (trade-window)
  FAIL  raiding the route cut the trade income: 0.500 -> 0.500 aluminium a tick, with no land engagement
  FAIL  the convoys themselves are being sunk: 0.16 lost under the raid against 0.16 to wear alone in the same window, with the yards silent
  ok    the invasion put to sea (accepted)
  ok    the crossing is on the wire for everyone — a spectator can watch it coming, which is the §6.8 defence
  ok    the crossing took 11 tick(s) — an operation, not a teleport (12 a zone)
  ok    the beach at province 56 is the island's beachhead now
  ok    the beachhead is supplied over the sea: 100.0% — above the no-convoy floor of 25%, so the convoys are carrying it
  --break=moored: the flotillas stay in harbour (supply-window)
  FAIL  raiding the route starved the beachhead: supply 100.0% -> 100.0%
  ok    and never to nothing — a cut convoy line is a worse one, not a severed one (invariant 2)
  ok    and the beachhead held through all of it
  ok    the world stayed healthy throughout (0 ms behind at tick 8304)
FAIL
```

### Phase 8 — air zones### Phase 8 — air zones

```
phase-8 gate
  world world-0 at tick 166943, 50 ms a tick
  nation 26 faces nation 25 over 5 province(s) in air zone 22
  clearing 3 division(s), 5 wing(s) and 2 line(s) left by an earlier run
  clearing 4 division(s), 0 wing(s) and 2 line(s) left by an earlier run
  air base in province 339, zone 22
  bombers: 4 factories making bomber
  making 90 bombers for 5 wing(s)...
  ok    raised 5 bomber wing(s)
  5 wing(s) at strength, on the ground
  ok    the garrison in province 314 reports its supply
  ok    and nothing changed hands under it, so supply is the only thing measured
  ok    bombers over the zone cut its supply: 1.000 -> 0.893 (10.7%)
  ok    and never to nothing — 25% is the cap, and a cut supply line is a worse one, not a severed one
  ok    bombing the zone cut construction: 2.0000 -> 1.8286 a tick
  ok    and left the factories running — 20% is the cap, and invariant 2 has no exception for being bombed
  defence-rifles: 3 factories making infantry_equipment
  defence-guns: 1 factory making artillery
  offence-rifles: 3 factories making infantry_equipment
  offence-guns: 1 factory making artillery
  ok    the attacker's factories retooled from bombers to rifles
  building supply hubs on both sides of the front...
  nation 25: 4 of 4 front provinces have a hub
  nation 26: 3 of 3 front provinces have a hub
  garrisoning 4 province(s) and staging against them...
  garrison in 318: 86%
  garrison in 323: 86%
  garrison in 327: 86%
  ok    the garrisons equipped — a front against empty provinces measures nothing
  4 garrison(s), the weakest at 86%
  3 attacking division(s) staged
  ok    the front splits in two
  without bombers: held 40, 40 tick(s) — mean 40.0, 0 of 2 fell, divisions at 80%
  with bombers   : held 2, 1 tick(s) — mean 1.5, 2 of 2 fell, divisions at 81%
  ok    air superiority shifted the ground battle: the line held 40.0 ticks against the same army with no air, and 1.5 with bombers over it
  ok    the world stayed healthy throughout (0 ms behind at tick 168070)
PASS
```

**Three checks, cheapest first**, and the first two exist because they prove
the zone machine works at all before the expensive one asks whether it changes
a battle. Interdiction cut a garrison's supply by a tenth and stopped short of
the cap; bombing cut what the zone's factories make. Neither reaches zero,
which is invariant 2 twice over.

**The third is §8's own sentence**, and the way it is measured matters. Ticks,
not provinces: the two sides are deliberately close, so every province falls
sooner or later and counting them reads "all of them" both times. What air
changes is the chance of winning each tick's roll, and that shows up as the
front moving faster. Forty ticks against nothing, one and a half with bombers
overhead — same army, same strength, same garrisons.

**And it was checked against itself being broken, two ways:**

```
$ node scripts/phase8-gate.mjs --break=grounded
  without bombers: held 40, 40 tick(s) — mean 40.0, 0 of 2 fell
  with bombers   : held 40, 40 tick(s) — mean 40.0, 0 of 2 fell
  FAIL  air superiority shifted the ground battle

$ node scripts/phase8-gate.mjs --break=idle
  FAIL  air superiority shifted the ground battle: the line held 20.5 ticks
        against the same army with no air, and 40.0 with bombers over it
```

`--break=grounded` never sends the wings anywhere; `--break=idle` sends them
with no mission. Both leave every other line of the gate untouched, which is
what makes them counter-proofs rather than different runs. Both fail at the
check they aim at and at no earlier one.

### Phase 7 — diplomacy and trade

```
phase-7 gate
  world world-0 at tick 10086, 50 ms a tick
  ok    a spectator is sent trust, which is public, and no economy, which is not
  nation 8 offers nation 9 a standing trade
  ok    both sides see the exact rates before accepting
  ok    a third party sees that the two are talking, and not what about
  ok    the offer was accepted (accepted)
  ok    the buyer receives steel at the agreed rate (0.500/tick)
  ok    and pays for it in construction points, which is the only currency there is (0.250/tick)
  ok    the seller is short exactly what it sent (-0.500/tick)
  killing the world...
  the world came back at tick 10094, 50 ms a tick
  ok    the agreement is still standing after the restart, with nobody having renewed anything (id 11)
  ok    and on the same terms it was accepted on
  ok    and still moving at the agreed rate, with no action from either player
  ok    the other side is told while the goods are still moving, not after they stop (told: true, still moving: true)
  ok    and is told who gave notice (nation 9)
  ok    breaking it cost exactly 5 trust (100 to 95)
  ok    and everybody can see it: trust is public
  ok    while the restart itself cost nobody anything
  ok    a day later the flow has stopped and the agreement is gone
  ok    the world stayed healthy throughout (0 ms behind at tick 10119)
PASS
```

The restart is a real `docker compose kill -s SIGKILL` and a real restore from
the snapshot and the command log, and **neither player sends anything between
the agreement being made and it being looked at again.** There is no renewal
command in the protocol to send.

**And it was checked against itself being broken:**

```
$ node scripts/phase7-gate.mjs --break=survives
  --break=survives: cancelling before the restart
  killing the world...
  FAIL  the agreement is still standing after the restart, with nobody having renewed anything (id 8)

$ node scripts/phase7-gate.mjs --break=notified
  --break=notified: waiting for the flow to stop before looking
  FAIL  the other side is told while the goods are still moving, not after they stop (told: true, still moving: false)
```

The first one took three attempts and each failure taught something, which is
under "Traps already paid for" below: the clock override does not survive a
`compose up`, and a restore replays the command log up to its **last command**
and no further, so a dissolution with no command after it is rolled back by a
kill and simply happens again on the way up.

**Run the counter-proofs on a world the phase-7 gate has not already used.**
Its own run signs an agreement between the only pair it found workable, so a
counter-proof straight afterwards exits 2 with "a world this gate cannot use"
rather than failing. That is the gate refusing to measure nothing, and it is
why the two runs above were taken on separate worlds.

### Phase 6 — supply

```
phase-6 gate
  world world-0 at tick 98209, 50 ms a tick
  ok    a nation is sent its own economy; a spectator is not
  ok    the wire carries a supply figure per division
  clearing 2 division(s) and 0 line(s) left by an earlier run
  ok    the nation draws supply from 2 source(s)
  playing nation 8: 26 of its own provinces connected to 2 capital(s), the furthest 7 hops out
  ok    raised 4 divisions to compare
  division 38 in province 63, 0 hops out, supply 100%
  division 39 in province 65, 4 hops out, supply 48%
  division 40 in province 59, 3 hops out, supply 59%
  division 41 in province 57, 2 hops out, supply 75%
  ok    the division at the end of the line is worse supplied than the one at home: 48% against 100%
  giving them something to lose...
  2 military factories to work with
  ok    1 factory on rifles and 1 on artillery, both running
  ok    the divisions drew enough to have something to lose (20.7%)
  watching the line stretch...
  watched 2400 tick(s) with the shelter holding
  ok    both divisions are still on the roster
  the front came within reach of one of them on 0 tick(s)
  ok    the division at the end of the line came apart on its own: 42.3% at its best, 0.0% now
  ok    and it is still short: 48% of what it needs is getting through
  ok    with no enemy action at either division for the whole window (0 disturbed ticks)
  ok    while the division at home has everything it asks for (100%)
  ok    the world stayed healthy throughout (0 ms behind at tick 100624)
PASS
```

The load-bearing words in §8's sentence are **alone** and **without enemy
action**. A division that got weaker while a war was going on has proved
nothing, so this gate raises at most `sources × SUPPLY_SOURCE_THROUGHPUT`
divisions — which puts national coverage at exactly 1 and leaves distance as
the only thing that can differ between them — and stands the two it watches
where the front cannot reach them at all.

§8's other half, "full supply recompute stays under 50 ms on the largest map",
is not in this gate. It is a unit test, because it is a statement about a
function rather than about a world, and measuring it through a WebSocket would
measure the WebSocket. `tests/server/Supply.test.ts` times a full recompute for
all fifty-two nations and prints the figure.

**And it was checked against itself being broken:**

```
$ node scripts/phase6-gate.mjs --break=supplied
  --break=supplied: everybody stands on a source
  ok    raised 2 divisions to compare
  division 36 in province 63, 0 hops out, supply 100%
  division 37 in province 77, 0 hops out, supply 100%
  FAIL  the division at the end of the line is worse supplied than the one at home: 100% against 100%

$ node scripts/phase6-gate.mjs --break=attrition
  ok    the divisions drew enough to have something to lose (20.2%)
  watching the line stretch...
  FAIL  the division at the end of the line came apart on its own: 34.6% at its best, 34.6% now
```

Both now stop at the check they are aimed at. `--break=attrition` used to fail
in the setup instead, which proved only that the setup was broken — and it was.

### Phase 5 — research

```
phase-5 gate
  world world-0 at tick 3070, 50 ms a tick
  ok    a nation is sent its own economy; a spectator is not
  playing nation 17: 4 slots on the wire, 2 of them unlocked, 0 techs known
  ok    the nation has a research slot to work with
  ok    the line is running, so there is a number to move
  one factory turns out 0.4000 a tick before any research
  ok    and that is the base rate the config states, with efficiency, sufficiency and the factory count divided back out (0.4000 vs 0.4)
  ok    a tech whose prerequisites are missing is refused: deep_mining needs excavation first
  slot 0 starts machine_tools on tick 3074
  ok    progress was seen moving on 478 separate ticks
  ok    and it moved by exactly one tick's work each time (0 jumps)
  ok    machine_tools finished on tick 3553
  ok    and the nation holds it: machine_tools
  ok    the slot is free again, ready for the next one
  ok    with the tick before it on record too (3552 and 3553)
  ok    and the line was measurable on both of them
  ok    one factory now turns out 0.4400 a tick against 0.4000 — 10.0%, and the tech claims 10.0%
  ok    the world stayed healthy throughout (0 ms behind at tick 3553)
PASS
```

The whole difficulty of this gate is the word _measurably_. Every number on the
wire moves for reasons that have nothing to do with research: the ramp climbs a
step, a shortage scales everything down, a front costs a province. So it measures
the one term research actually touches, isolated. The server computes

```
outputPerTick = factories × perFactory × efficiency × sufficiency / cost
```

and the wire carries `factories`, `efficiency`, `sufficiency` and
`outputPerTick`, so `perFactory` can be divided back out of figures already on
the screen. `machine_tools` claims +10%, and 0.4000 becomes 0.4400 on the
single tick it lands.

**That design found a real bug before it ever ran.** `World.ts` computed
`outputPerTick` from the `MILITARY_FACTORY_OUTPUT` constant rather than from
the researched rate, so a nation with `machine_tools` would have produced more
than its own production screen said it did. Nothing else would have noticed:
the simulation was right, only the wire was lying.

**And it was checked against itself being broken:**

```
$ node scripts/phase5-gate.mjs --break=modifier
  ok    with the tick before it on record too (4044 and 4045)
  ok    and the line was measurable on both of them
  FAIL  one factory now turns out 0.4000 a tick against 0.4000 — 0.0%, and the tech claims 10.0%
FAIL (1) — stopped at the first failure, as intended
```

### Phase 4 — production and equipment

**The transcript below is the run from _before_ the gate was rewritten**, and it
still talks about the border drift walking a front onto a division. The gate now
connects a second nation, garrisons the province and orders the front itself
(commit `bdec07ff`); it passes, and the shape of the checks is unchanged. Replace
this block with a fresh run the next time the gate is run on a world at 50 ms.

```
phase-4 gate
  world world-0 at tick 40317, 50 ms a tick
  ok    a nation is sent its own economy; a spectator is not
  playing nation 17: 43 provinces, 6 military factories, 5806/10824 manpower
  clearing 2 production line(s) and 4 division(s) left by an earlier run
  building an industry...
  6 military factories
  ok    line 6 makes rifles on 4 factories, line 7 makes guns on 2
  ramping the line and filling the stockpile...
  line 6: infantry_equipment on 4 factories at 97.9%, 0.892 a tick
  line 7: artillery on 2 factories at 98.0%, 0.112 a tick
  stockpile 475 rifles and 48 guns — 4 division(s) worth, at 52% sufficiency
  ok    taking a factory off the line and putting it back left the ramp alone (97.9% -> never below 98.0%)
  ok    the line climbed to 100.0% before anything was taken from it
  ok    switching the line threw the ramp away: 100.0% -> 10.1% on tick 41602
  ok    and the line makes fighters now, not rifles
  12 border provinces, manpower for 6 divisions, equipment for 7; raising 6
  control division 7 in province 156, well behind the line
  ok    raised 5 divisions on the frontier, and one behind it as a control
  letting them draw what there is, then watching the front...
  ok    the front cost this nation equipment on 8 separate ticks, in steps too big to be supply attrition
  ok    every one of those losses was a province changing hands under the division that took it — 0 were not
  the control division behind the line lost equipment on 1 tick(s); the drift can walk the front onto it, which is why the check above is the attribution and not its silence
  ok    division strength fell while it ground on: 4.341 -> 0.000 across 6 divisions
  ok    and the rifles and guns it destroyed never came back — with nothing being produced the stockpile only ever fell (890 -> 0.0, 0 rises)
  ok    and replacing what it destroyed cost 890 rifles and guns out of the warehouse — more than the 112 a whole division is made of
  ok    getting back to 100.0% took 899 ticks — 37.5 in-game days of lost output
  for reference, the line made 24.30 rifles a day before the switch
  ok    the world stayed healthy throughout (0 ms behind at tick 42540)
PASS
```

Two halves, and §8 words them plainly: a sustained fight visibly drains a
stockpile and weakens units, and switching a production line visibly costs the
player output for a long time.

The load-bearing check is the attribution. Reinforcement only ever _adds_ to a
division and combat only ever _takes away_, so a tick on which a division got
weaker is a tick something cost it equipment — and the gate then demands that
every such loss coincides with a province changing hands under that division or
next to it. That is what makes this half mean "the fight did it" rather than
"something did it".

Since phase 6, combat is no longer the only thing that empties a division: an
under-supplied one wastes away at up to two percent a tick with no enemy
anywhere near. A clash costs five or eight. The gate ignores falls below four
percent for exactly that reason, and the constant says so.

**And it was checked against itself being broken, three ways:**

```
$ node scripts/phase4-gate.mjs --break=quiet
  FAIL  no clash ever landed on a division, so nothing here was exercised

$ node scripts/phase4-gate.mjs --break=reset
  FAIL  switching the line threw the ramp away: 70.2% -> 70.2% on tick 46056

$ node scripts/phase4-gate.mjs --break=drain
  FAIL  no clash ever landed on a division, so nothing here was exercised
```

**One of those three did not exercise what it is aimed at.** `--break=drain`
freezes the stockpile reading, so the check that has to notice is "the fight
spent the warehouse" — but on that run no clash landed on a division inside the
budget, and the gate stopped at the earlier check instead. It failed, which is
what a counter-proof has to do, but it failed for the same reason
`--break=quiet` does. Run it again on a busier world to see it fail at the line
it is actually for.

`--break=quiet` is the strongest of the three: it puts nothing at all on the
frontier, so no clash can land on a division, and the gate has to notice that
its subject never happened rather than finding a drain somewhere else and
calling it a fight.

### Phase 3 — factories and construction

```
  building military factories until the mines cannot keep up...
  factory 1 in province 158 (demand 0.80, mined 0.83)
  factory 2 in province 158 (demand 1.40, mined 0.74)
  ok    2 more military factories now demand 1.40 steel a tick against 0.40 mined
  waiting for the stockpile to run out...
  ok    sufficiency fell to 28.4%
  ok    industry kept running at 0.625 a tick rather than stopping
  ok    and it ran at exactly the share of demand that was covered — 28.4% of 2.200
  ok    the factories are still there and still asking for resources
  ok    and construction was untouched — civilian factories draw nothing
  ok    the world stayed healthy throughout (0 ms behind at tick 51284)
PASS
```

The last five lines are the gate; everything above them is the gate putting the
nation in a position where invariant 2 can be observed. It builds military
factories until they demand two and a half times what the mines produce, and
then waits for the stockpile to go. What the economy must not do is stop — and
it does not; it runs at the share of its demand that was covered, and
construction, which draws no resources, is untouched.

**Phase 4 changed what a factory draws and this gate still passes**, which is
the point of the flat rate surviving for unassigned factories. See
[decision 0009](docs/decisions/0009-a-factory-is-fed-by-what-it-makes.md).

### Phases 2 and 1

```
phase-2 gate
  artefact on disk: 529 provinces, partition 5a8a6c17, terrain bd09055c
  world world-0 at tick 3038
  ok    the world runs the artefact on disk: 5a8a6c17 === 5a8a6c17
  ok    and the terrain it was generated from
  ok    529 provinces, on the wire and on disk
  ok    every one of 492907 land tiles carries its province's controller
  ok    no water tile carries a nation
  ok    no tile names a nation this world does not have
  nation 22 holds the most provinces (43)
  claimed province 223 for tick 3044 (222 refused on the way)
  ok    the claim moved the controller of province 223
  ok    and left its owner alone — holding is not owning (decision 0002)
  ok    all 893 tiles of province 223 now read nation 22
  letting the world run, then asking for a fresh full state...
  ok    a world rebuilt from 11 deltas matches a fresh full state at tick 3051
  ok    and agrees about ownership too
PASS

$ node scripts/phase2-gate.mjs --break=artefact
  FAIL  the world runs the artefact on disk: 5a8a6c17 === 5a8a6ce8   → exit 1
```

And phase 1, which goes last in any chain because it kills the container:

```
phase-1 gate
  world world-0 at tick 51287, last snapshot 51240
  nation 22 holds the most provinces (42)
  connected as nation 22 at tick 51287
  claimed province 228 for tick 51289 (223 refused on the way, which is the rejection path)
  waiting for a snapshot after that command...
  snapshot at tick 51300
  ok    the late claim (tick 51332) is after the snapshot (51300)
  claimed province 224 for tick 51332
  ok    saw the world at tick 51332
  SIGKILL to the world container
  the world came back, resuming at tick 51332
  ok    resumed at the last durable tick: 51332 === 51332
  ok    the tick did not restart from zero (51332)
  ok    the restored world passed back through 5 tick(s) this client had seen
  ok    every replayed tick hashes identically (51332, 51333, 51334, 51335, 51336)
  ok    the late command is in the log: 51332:0:22:224
  ok    the early command is still in the log: 51289:0:22:228
  ok    the restored world reports healthy
PASS
```

**Note what the restart does to the clock.** The gate brings the container back
without `WORLD_TICK_MS`, so the world returns at its real five seconds a tick
and every gate run after it refuses with instructions rather than hanging —
which is the override working, but it means phase 1 goes _last_ and the clock
is put back by hand afterwards.

The phase-1 hash line is the one that matters. The client tracks province
ownership from the full state and the deltas and hashes it per tick with the
same function the server uses; after the restart the world replays back through
ticks the client already saw, and those hashes have to match. A restore that
produces a _plausible_ world rather than _the_ world is caught by exactly one
line, which is why that line exists.

The phase-2 gate parses `provinces.bin` itself rather than importing the
project's decoder. That is deliberate: a gate that calls the same function the
server calls proves only that the function agrees with itself.

**What the phase-2 gate does not do is look at the screen.** CLAUDE.md §8 ends
its gate with "and the client renders it correctly", and this project has no
automated browser leg (see the trap below). Everything up to the pixels is
proven here; the pixels are the morning checklist.

---

## What the phase-6 gate was really asking

**This file predicted the fix and the prediction was wrong**, which is worth
more than the fix itself. It said: pick far provinces whose supply is between
about 20% and 60% instead of the furthest ones, "and the run should complete —
that last clause is an expectation, not a result". The band was necessary. It
was not sufficient, and two other things had to be found by measuring.

**One: a province at 0% supply really is useless to this gate**, and the band
is the answer to that. Measured on world-0 with a division standing at every
distance at once: 0 hops 100%, 1 hop 86%, 2 hops 75%, 3 hops 59%, 4 hops 48%,
7 hops 0%. The gate now stands a division at every distance it can reach and
reads off which of them landed between `BAND_LOW` and `BAND_HIGH`, because
supply reaches the wire per _division_ and not per province — it cannot be
computed in advance without copying the server's cost model, and a gate that
copies what it checks checks nothing.

**Two: making one equipment type at a time cannot arm a division that is
losing equipment.** The gate put every factory on artillery for seven hundred
ticks and then every factory on rifles, and the division it was watching
finished at 0.0% both times — with the band fixed and supply at 48%. With the
lid off: a short division loses a share of what it _holds_ every tick, a
half-life of about seventy ticks at that supply, so whichever type is not
being made right now is evaporating. By the time the rifles arrived the guns
were gone, and `divisionStrength` is the worst ratio across the template
(§6.3), so a hundred rifles and no guns reads zero. One type at a time cannot
equip such a division; it can only take turns starving it. Run in parallel the
two settle: production per tick against a loss proportional to the holding is a
first-order lag, and the division sits at what the lines can sustain — 42% of
template, on two factories split one and one.

**Three: "without enemy action" had to become a property of where the gate
stands.** The heartbeat in `combat.ts` flips one province per tick for ever, so
over a 2,400-tick window it came within reach of the watched divisions on 39 of
them and the gate — rightly — refused to call that a clean measurement. But a
flip only ever destroys equipment in the province that changed hands and in the
one it was attacked from, and neither can be a province all of whose
neighbours are the nation's own. So both watched divisions now stand in a
province that is interior _and_ all of whose neighbours are interior, the
window lasts exactly as long as that shelter does, and `disturbed === 0` stayed
a hard check rather than becoming a tolerance. Measured before it was written:
twelve such provinces watched for 3,001 ticks, none lost its shelter, none was
touched once. The last run watched the full 2,400 ticks with 0 disturbed.

Two smaller things fell out of the same work:

- The gate counted **every supply hub on the map** as one of the nation's own
  sources — `buildings` on the wire is every province (§7), not just yours.
  `sources` caps how many divisions get raised, and too high a cap puts
  coverage below 1, which would have left the home division short of the 100%
  the last check asks it for, for a reason that has nothing to do with
  distance. On world-0 nobody has built a hub yet, so it read zero and hid.
- A window shorter than `MIN_WATCH_TICKS` now exits 2 with an explanation
  instead of passing. An eight-tick window did once produce a technically
  correct fall, and it proved nothing.

## The commits

Phases 0 to 3 are in the history of this file before this rewrite; `git log`
has them all.

Phase 4:

| Commit     | What                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `3b125690` | **Production lines, the efficiency ramp and its reset, equipment, divisions, manpower, and a border clash that destroys equipment** |
| `985c5936` | Materials by equipment type, and `scripts/phase4-gate.mjs` with three counter-proofs                                                |
| `ba05c98b` | The production screen, and a division you can raise                                                                                 |

Phases 5 and 6 landed together, because they share a wire version and could
not be split into commits that each build:

| Commit     | What                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| `985c5936` | **Research and supply**, their gates, and decisions 0009 and 0010        |
| `ba05c98b` | The research screen, and supply shown beside equipment on every division |

The night and morning of 2026-08-31/09-01 (all six pushed to `origin/main`):

| Commit     | What                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `f4ba4047` | **The state-hash check holds within a hash version** (decision 0016) — a season survives a deploy that touches the state                     |
| `8ef82a66` | **The front is a rate, painted tile by tile** — progress on every attack, public `fronts` on the wire, gates 4 and 8 rebuilt around the rate |
| `671c71e7` | A menu instead of six open panels                                                                                                            |
| `3e0e9035` | **The sea: phase 9's systems** — SeaGraph (decision 0017), ships, convoys in supply and trade, `naval_invade`, wire 13, hash version 3       |
| `e563d053` | The handover for the night, and the gate specification phase 9 then had to satisfy                                                           |
| `98b44426` | **The phase-9 gate passes** — and its counter-proof caught naval.ts pricing a one-zone route's raid exposure at zero                         |

Phase 7:

| Commit     | What                                                                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cea1894e` | **Agreements, trust, per-tick trade, the world market, the diplomacy panel, `scripts/phase7-gate.mjs` and decision 0011** — and two fixes it turned up: a production line that could not be stood down once its factories were lost, and a phase-1 gate that could not see a replay at fifty milliseconds a tick |

And what it took to get phase 6's gate green, none of which was the simulation:

| Commit     | What                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `3f309ddc` | The gate waited on a stockpile that is a pass-through; it waits on division strength now                |
| `f6f08866` | An `assign_factories` that was acked and never applied, and the silence after it                        |
| `e7496a92` | **The band, both lines running together, and a shelter the front cannot reach** — see the section above |

---

## What the browser found that no gate could

Three bugs, all in the client, all found on 2026-08-31 by a person opening the
page rather than by anything failing. They are worth writing down together
because they are the same kind of failure: **the server was right, the tests
were green, and the game was unusable.**

**The HUD was under the map.** `#world-hud` and the canvas are both
`position: fixed; inset: 0` and both at `z-index: auto`, and the canvas is
appended to the body _after_ the HUD — so at equal stacking the map painted
over every panel. The HUD was fully built and fully populated the whole time:
`elementFromPoint` over the economy panel's own centre returned
`world-canvas`, while the panel's text read
`Wirtschaft · Bau 36.0/Tag · Industrie 9.60/Tag`. No error, no console
message, nothing hidden. It survived phase 3's HUD, phase 7's diplomacy panel
and phase 8's air panel. One line fixed it, and
`tests/client/world/HudProduction.test.ts` now asserts that `#world-hud`
declares a `z-index` — the rule rather than the outcome, because jsdom has no
layout to measure.

**The HUD never said which nation you were.** Every panel showed one nation's
numbers and none of them said whose. The name was on the wire from phase 0,
used for the diplomacy list and nowhere else. The first panel's heading is the
nation's name now.

**The camera opened on the middle of the map.** On a continent that means
arriving pointed at nobody's territory and hunting for your own. It frames what
the nation controls now, from the province centres in the artefact. A spectator
still gets the whole map.

The lesson is the one this file has claimed since phase 1 and had never had to
pay for: **everything here is proven by a script except the browser, and the
browser is where a game is either playable or not.** Two of these three had
been shipped for phases.

## A division at a badly supplied front is a bottomless pit

Found while staging the phase-8 gate, and it is about the game rather than
about the script — a player will meet it too.

§6.6 wastes an under-supplied division at `SUPPLY_ATTRITION × (1 - supply)` a
tick. On a typical front supply runs about 0.6, so the loss is 0.8% a tick —
and 0.8% of a division's twelve guns is 0.096, against an artillery line that
makes 0.1. The division sits in equilibrium _just below full_. It never stops
asking for reinforcement, and `reinforce` walks a nation's divisions in order
and gives each what it asks for out of what is left, so it starves every
division behind it in the list.

The gate read `90% 4% 0% 0%` for ten minutes because of this, and no amount of
extra factories fixed it — more factories on a steel-poor nation only lower
`sufficiency` and slow every line down together.

**The fix is the one a player would reach for: build a supply hub first.** 150
points, and the province becomes a supply _source_, so reach there goes to 1
and the attrition goes to nothing. Then the divisions fill.

Two consequences worth keeping:

- **Feed the front before garrisoning it**, on both sides. An attacker's
  divisions stand at a front too, and once production stops they waste away
  exactly the same way.
- **Few full divisions beat many empty ones.** Because reinforcement is
  sequential, raising four divisions at once does not share the warehouse
  between them — it queues them, while looking like nothing is happening.

## What the phase-8 gate kept getting wrong

Left here because the next gate that stages a fight will hit all three.

- **Production during the measurement window.** The first version raised
  attackers at 35% strength and watched them take every province without any
  air support at all — the factories were still running, and a division that
  starts a fight under-equipped is at full strength forty ticks later. The
  warehouse refills it faster than the fighting empties it. **Stand the lines
  down for the duration of the window**, or measure the factories rather than
  the sky.
- **Rifles without artillery.** `divisionStrength` takes the _worst_ ratio
  across `DIVISION_TEMPLATE` (§6.3), so a division holding every rifle it
  wants and no guns is not 90% of a division — it is 0% of one. A gate that
  produces only `infantry_equipment` waits forever for divisions that can
  never become strong, and the fight below it is unwinnable by anybody.
- **Bombing something that is not there.** `strategic_bombing` scales what
  factories make, per province. A defender whose industry all sits in another
  air zone loses exactly nothing however many bombers are overhead, and the
  check then measures the map's geography instead of the mechanic. The gate
  builds a factory in the zone it intends to bomb.

## Deployed, and what that does not include

The world runs on the machine `geoffrey` at
`http://144.91.89.2:8095/`. **Host specifics are deliberately not in this
repository** — they are in `docs/deploy/HOST.local.md`, which `.gitignore`
keeps out because this repo is public.

Two things about it belong here, though, because they are decisions rather than
details:

- **It has no accounts.** §8 puts deployment _after_ phase 11 for exactly this
  reason: anyone who reaches the URL can play any nation by putting its number
  in `?nation=`, read that nation's treaty terms and cancel its agreements.
  Deploying first was a deliberate call to get a live test, made knowingly. It
  is not a state to leave a world in.
- **It has no TLS**, because it has no DNS record, because the zone is on
  Cloudflare and there is no API token on either machine. The vhost for the
  ACME challenge is already in place; the certificate is one command away from
  a record existing.

## What you have to look at yourself

Everything above is proven by a script. This is the part that is not, because
this project has no automated browser leg. Ten minutes:

```bash
docker compose up -d
npm run start:client
```

Then open `http://localhost:9000/?nation=17` (or any nation number) and check
— **the first four are this night's work and nobody has ever seen them**:

0a. **The menu bar**: six glyph buttons top-left, one panel at a time, the
map visible behind. Panel switches keep a half-typed trade rate alive.
0b. **A front fills tile by tile**: order an attack on a garrisoned province
(two browsers help); the province should fill with your colour from your
border inward as `progress` climbs, while its controller stays theirs
until it completes. Call it off: the tiles fall back.
0c. **The fleet**: a coastal province with a naval base offers the three
ship types on its raise buttons; the assignment form offers sea zones
and sea missions the moment a fleet is selected (one form, two
theatres).
0d. **An invasion**: with a division on your coast, a hostile coastal
province's panel offers "Invade from the sea". The division shows "at
sea" in the production panel while it crosses.

Then the standing list:

1. **The map draws territory** — coloured regions, not a blank canvas.
2. **Province borders are visible** as dark seams inside each nation, and
   `b` turns them off and on again.
3. **Six panels**: economy top-left, construction queue beside it, production
   bottom-left, diplomacy beside that, research bottom-right, and a province
   panel on the right when you click a province.
4. **Clicking a province you hold** shows its terrain, slots, deposits, a
   build menu and a **Raise a division** button with its manpower price on it;
   clicking one you do not shows a claim button instead.
5. **Queue a civilian factory**. The queue panel should show a bar that moves
   every five seconds and a "days left" that counts down.
6. **Open a production line** and give it a factory. Efficiency should start at
   10% and climb visibly over a few minutes; output should be shown per day.
7. **The switch button names its own price** — "Switch — throws away 34%" or
   whatever the line has earned. Do not press it unless you mean to.
8. **Start a tech.** The research panel should show a bar and a day count, and
   a tech whose prerequisites are missing should be greyed out.
9. **Raise a division.** It appears in the production panel with two numbers,
   equipment and supply. One at the capital should read 100% supply; one out at
   a border should read less.
10. **The numbers are all per day**, never per tick, and the stockpiles move.
11. **A world nobody is attacking stands still.** The border drift is gone
    (decision 0014), so an idle map is correct rather than broken. To see the
    front, click a province you do not hold: the button reads **"Attack this
    province"**, and once pressed it becomes **"Call off the attack"** with
    _"Your front is grinding here, every tick."_ under it. The same front is
    listed under **Fronts** in the production panel with a button beside it.
    Nothing marks it on the map itself.
12. **Offer somebody an agreement.** Pick a neighbour in the diplomacy panel,
    choose a type, and send it. A trade wants a resource and two rates, both
    entered per day. Open a second browser as that nation (`?nation=<them>`)
    and the offer should be sitting there with the exact rates on it.
13. **Accept it**, and watch the economy panel: the buyer's construction slows
    by what it agreed to pay, and the resource line moves the other way. That
    is the whole price mechanism, and it should be visible without opening
    anything.
14. **The cancel button names its own price** — "Give notice — costs 5 trust".
    Press it and the other side should say so immediately, while the goods
    keep moving for one more in-game day.
15. **The world market** should fill a standing order for anyone, with no
    counterparty and at obviously bad rates.

**Everything the browser needs was checked from outside it**, so a blank page
means the rendering and nothing else. If 1 or 2 fail, open the console: a map
or artefact mismatch is thrown with both hashes in the message, and a stale
`provinces.bin` out of the HTTP cache is the likely cause — hard-reload.

The HUD's German is picked from `navigator.language`; it has no picker yet.

---

## What to do next

**First: open the browser.** Items 0a–0d of the checklist below have never
been seen by a person — the front filling tile by tile, the menu, the fleet
side of the assignment form, an invasion under way. Everything else in phases
1–9 is proven by scripts; those four are not, and a gate cannot tell you the
game is unplayable.

**Then phase 11 — accounts** (plan §5, decision 0013): greenfield, no auth
code and no tables exist. **Phase 11 also owes the regent its season rule**
(decision 0018): when accounts arrive, the season opening switches regents on
for every nation no account holds — forget it, and §6.10's promise is
silently unkept. The insertion point for the credential check is
`WsServer.ts`'s hello block; the `hello` schema's own comment names the job.

**Then the victory system** (plan §7) and **phase 12's deployment remainder**
(plan §6 — DNS/TLS needs a Cloudflare token or a hand-created record, and the
deployed demo on geoffrey still runs the pre-front build; a redeploy restarts
that world, since both the state hash and the protocol moved).

**Then the map's real borders** (plan §8) — the standing request, and it
invalidates every running world, so plan it with a season boundary.

**What phase 7 actually built**, for anyone reading §6.5 against the code:

- Four agreement types, all bilateral, all indefinite. `propose` → `accept` or
  `decline`; `cancel` gives notice and costs trust. There is no renewal command
  because there is nothing to renew.
- A standing trade moves a resource one way and **construction points** the
  other, per tick, scaled down together when either side falls short. Points
  are a flow with nowhere to keep them, so the payment happens where it is
  felt: `construction.ts` asks `constructionAvailable` instead of measuring its
  own output.
- A world market at deliberately bad rates, always available, no counterparty,
  no obligation — which is what keeps an isolated or island nation playable,
  and the only economic lever the regent will be allowed in phase 10.
- Trust, public to everyone, spent by cancelling and never earned back.
- The dead-partner rule, reading `lastSeenTick`, which every accepted command
  sets — including the `nation_present` one the socket layer writes on
  connect. Decision 0011 is about that one command and why it exists.
- ~~Land routes only~~ — **phase 9 delivered the sea route**: the route is
  resolved every tick now (`systems/routes.ts` — land moves free, sea moves
  on the importer's convoys and under raiders, none at all moves nothing this
  tick while the agreement stands), and the propose/accept refusals ask for
  _some_ route rather than a land one.

Still worth doing, and still deferred:

- **A language picker.** The HUD has its own English/German catalogue in
  `client/world/ui/strings.ts` and reads `navigator.language`.
- **Supply's per-type half.** §6.6 wants consumption proportional to a unit's
  equipment and type; it is still flat per division. (The sea path itself is
  no longer deferred — phase 9 built it.)
- **Rendering an invasion on the map.** The crossing is public on the wire
  (`invasions`) and shown in the owner's division list; nothing marks it on
  the map itself yet.
- **Deployment to a real host** (phase 12) and **accounts** (phase 11, see
  below). The nation still comes from `?nation=` in the URL.

Two long-standing deferrals **closed by phase 9, the other way than planned**:
the water provinces became decision 0017 (no format bump — the sea-zone graph
is derived at load), and upstream's four deleted pathfinding wrappers found no
consumer after all — invasion transit routes over the zone graph, and the
surviving `shared/pathfinding/AStar.Water*` algorithms stay unused.

---

## Open questions

### Balance questions phase 7 leaves on the table

None of these blocked the gate, and all are one line in
`shared/config/diplomacy.ts`. The third was decided on the day and is kept here
with its answer; the first two are still open.

**Trust never comes back.** §6.5 says what cancelling costs and says nothing
about recovery, so nothing recovers it: a nation that breaks a non-aggression
pact spends 75 of its 100 and is diplomatically poor for the rest of the
season. That may be exactly right — "serial betrayers become diplomatically
isolated" is the stated aim — or it may make the first betrayal the last
interesting decision a nation makes. A slow regrowth would be a mechanic §6.5
does not ask for, which is why there is not one.

**The costs themselves.** `trade: 5`, `military_access: 10`, `alliance: 35`,
`non_aggression: 75`. The ordering is §6.5's own and the surprising half of it
is deliberate — breaking a non-aggression pact costs more than breaking an
alliance, because there is only one reason to do it. The magnitudes are a
guess.

**Fourteen in-game days was twenty-eight real minutes — decided and changed.**
`DEAD_PARTNER_TICKS` is now seven days of wall clock (120,960 ticks), derived
from `TICK_MS`. §6.5's own unit made the rule fire on a player who closed the
tab over lunch, which is plainly not what "no player login" means in a world
whose in-game clock runs a hundred and eighty times faster than the real one.
Decision 0012 has the reasoning and the two consequences: the rule is no longer
observable in a gate run and is unit-tested instead, and an offer to a nation
nobody has ever played is now accepted rather than refused, because on a young
world nobody is dead yet.

**And one sharp edge, for the same list.** The other half of the dead-partner
rule is "has lost its capital", and it is read as _holds no capital right
now_. A capital that changes hands for a single tick therefore dissolves every
agreement that nation has, with third parties included. Today that takes a
player ordering a front onto a capital and losing it again, which is rare;
when phase 9 lets a landing take a capital it will not be. The alternative is
a grace period, and a grace period is a duration, which is what invariant 3
exists to keep out — so this one needs thought rather than a constant.

### Anybody may claim anybody's nation — now phase 11

`hello` checks that the nation number exists and nothing else. No account, no
token, and two sessions may hold the same nation at once — a phase-1 deferral,
and until phase 6 the worst it bought an impostor was somebody else's
construction queue.

Phase 7 raised the price: the impostor is sent the **private terms** of that
nation's treaties, which §7 says only the two parties may see, and may
`cancel_agreement` in its name — spending trust the nation can never earn back.
Nothing in the diplomacy system can defend against it, because from the
server's side the impostor _is_ the nation.

**Decided on 2026-08-31: accounts are a phase of their own, and §8 has one
now.** Phase 11 is accounts and identity; deployment moved to 12, which is the
right order — a world reachable from outside with no accounts in front of it is
a world in which anybody is everybody. Decision 0013 records why a guarantee
the code cannot enforce is not a guarantee.

### Changing the state hash makes a running world unstartable

The world refuses to load a snapshot whose recorded hash does not match what
the code computes for it — which is right, and it is what phase 1's gate is
built on. But phase 5 added research to `stateHash()`, and the running world
then refused to start:

```
[world] failed to start Error: snapshot at tick 100860 does not hash to what
was recorded with it (4d9ed8c vs 737fcd1c); the stored state is damaged
```

Nothing was damaged. The hash function had changed, and the check cannot tell
that from corruption. Locally the answer is `docker compose down -v` and a
fresh world. **On a live season it is fatal**: no change that touches the
state hash — which is most simulation changes — could ever be deployed without
ending the season.

The suggested fix, which is Max's call because it changes what persistence
promises: record the code's **hash version** beside the snapshot, keep the
corruption check inside a version, and on a version change accept the snapshot
while logging loudly that the check was skipped for that load. That keeps the
guarantee where it is worth something and lets a season survive a deploy.
Nothing has been implemented; the question is open.

### `STARTING_DIVISIONS` is dead code

`shared/config/rates.ts` declares `STARTING_DIVISIONS = 2` with the comment
"Divisions a nation starts with, in its capital", and **nothing in `src`,
`tests` or `docs` reads it**. Nations start with no divisions at all.

Either the seeding was never written or the constant should go. Both are small
changes and both change the game, so neither was made: implementing it means
every nation begins with two empty divisions draining any stockpile they can
reach, and deleting it drops a design decision that was written down on
purpose. Nothing depends on the answer, so it can wait for one.

**Needs a decision before the world is deployed anywhere real** (phase 12):

- DNS record for the world's domain — who creates it, and by hand or via API.
- The deployment host had a pending reboot when this was last discussed.
- **Accounts.** `?nation=1` in the URL is the whole of authentication.

**Answered, recorded so they are not reopened:**

- A world resumes at its last durable record, not the tick it died on
  ([0005](docs/decisions/0005-resume-at-the-last-durable-record.md)).
- Manpower is a population-scaled cap, not a conscription law
  ([0008](docs/decisions/0008-manpower-is-a-population-cap.md)).
- A factory is fed by what it makes, and an idle one still eats
  ([0009](docs/decisions/0009-a-factory-is-fed-by-what-it-makes.md)).
- Research modifiers are read where the rate is read, never stored
  ([0010](docs/decisions/0010-research-modifiers-are-read-not-stored.md)).
- Occupied provinces produce at a reduced rate (`OCCUPIED_OUTPUT_FACTOR`),
  which answers one of §10's open questions.
- The border drift is gone; an unattended world is quiet until the regent
  ([0014](docs/decisions/0014-the-border-drift-gives-way-to-a-front.md)).

**Deliberately deferred** (`CLAUDE.md` §10 says to decide these only when they
block): season victory condition, how new players enter a running world,
whether ships are hull-and-module designed or three fixed types, whether trade
agreements can carry equipment.

---

## How to verify anything

```bash
npm run inst             # npm ci --ignore-scripts — never `npm install`
npm run typecheck        # tsc over everything, must be clean
npm run typecheck:strict # tsc over shared/ + server/ with strict: true
npm run lint             # oxlint + eslint, must be clean
npm run test             # one vitest run; see baseline below
npm run test:db          # the Postgres tests; needs `docker compose up -d db`
npm run build-prod       # tsc + vite + asset hashing; the real integration test
npm run check:doc-links  # every relative link in every .md resolves
npm run gen-provinces    # regenerate the province artefacts (see below)
docker compose up -d     # Postgres + the world
npm run start:client     # http://localhost:9000/?nation=17
```

And the gates, which need the faster clock and a world with some history:

```bash
docker compose down -v # phase 7 changed the state hash; see above
WORLD_TICK_MS=50 docker compose up -d --build
sleep 150 # manpower starts at zero and regrows

node scripts/phase2-gate.mjs
node scripts/phase2-gate.mjs --break=artefact # and it must fail
node scripts/phase3-gate.mjs
node scripts/phase4-gate.mjs
node scripts/phase4-gate.mjs --break=quiet # and these three must fail
node scripts/phase4-gate.mjs --break=reset
node scripts/phase4-gate.mjs --break=drain
node scripts/phase5-gate.mjs
node scripts/phase5-gate.mjs --break=modifier # and this
node scripts/phase6-gate.mjs
node scripts/phase6-gate.mjs --break=supplied # and these two
node scripts/phase6-gate.mjs --break=attrition
node scripts/phase7-gate.mjs                  # restarts the world; brings the clock back with it
node scripts/phase7-gate.mjs --break=survives # and these two
node scripts/phase7-gate.mjs --break=notified
node scripts/phase1-gate.mjs # last: it kills the container
```

**`npm run gen-provinces` is not part of the build.** It writes map data into
the repository, and `tests/shared/ProvinceArtifact.test.ts` fails until the
result is committed. If you change `ProvincePartition.ts`,
`ProvinceAttributes.ts` or `shared/config/provinces.ts`, run it and commit both
halves — that friction is the whole point of decision 0006.

### Test baseline

**609 passed, 8 skipped, in one run — no tolerated failures.** The eight
skipped are the Postgres integration tests, which run under `npm run test:db`
against `docker compose up -d db`. **They are a suite that rots when nobody
runs it**, so `npm run test:db` belongs in every phase's closing checks; it
passed 8/8 at the end of phase 10.

The count moved from 597 at the end of phase 9, from 567 at the end of
phase 8, from 533 at the end of
phase 7's build (the phase-7 review added eleven more), from 506 at the end
of phase 6's build, from 472 at the end of phase 4's build, from 462 at the
end of phase 3, from 437 at the end of phase 2 and from 412 at the end of
phase 1.
Roughly 300 test files test code that no longer exists and live in
`tests/_legacy/`, excluded from the run.

**Every failure is yours.** If you are looking for two tolerated red tests
because you read an older version of this file, stop looking.

### Measuring the boundary

After `npm run build-prod`:

```bash
ls static/assets/ | grep -i worker # nothing — the simulation is gone
du -h static/assets/index-*.js     # 456 kB at the end of phase 6, was 2.3 MB
```

If a later change re-imports the simulation by some route the boundary tests do
not model, the worker chunk comes back and the bundle jumps.

## Traps already paid for

Things that cost time to find. Do not rediscover them.

**Several of these are argued from the border drift, which no longer exists**
(decision 0014, phase 8). The lesson almost always still holds — and a few of
them hold harder now, for the opposite reason: a gate cannot wait for an
unattended world to reach a state, because an unattended world no longer moves
at all. Read the rule, not the reason.

### What the phase-7 review found

The gates were green and the tests passed, and then a multi-dimension review
over the diff found seventeen things anyway. Eleven were worth fixing and are
fixed; the interesting part is what kind of thing they were, because none of
them was the sort of bug a test suite written by the same person would have
caught.

**The worst one was in the UI and it threw the player out of the world.** The
diplomacy form's number fields started at 0. A rate of 0 fails
`TradeTermsSchema`, a schema failure is a _protocol_ violation, the server
closes the socket with `CloseCode.Malformed`, and `WorldSocket` treats that
code as terminal and never reconnects. So: open the panel, choose "trade",
press Send without typing — and you are out of the running world until you
reload the page, for pressing a button the interface offered you. Fixed at
both ends, and the second end is the one that matters: **the limits moved out
of the wire schema and into `World.rejectionFor`**, so a rate the world will
not take is now an ack with a reason. The wire checks shape; the world checks
rules (§7). Any future client bug in that class is now a refusal instead of a
disconnection.

_(The review reported this as firing on the untouched form. It does not —
"trade" is not the default agreement type, so the untouched form sends a
non-aggression pact with no terms at all. One click deeper, and real. Worth
knowing that the finding as written was slightly wrong and the bug was not.)_

**Two more that were real and older than phase 7:**

- **`nextOrderId` was never in the snapshot.** A restored world started
  handing out construction-order id 1 again while the queue it had just loaded
  still held one — so `cancel_construction`, which names an order by id,
  cancelled whichever the search reached first. And a replayed command log
  assigned different ids from the run it replayed, which is a divergence the
  state hash could not see, because the counter was not in the hash either.
  Phase 3 wrote it; phase 7 asked exactly this question about
  `nextAgreementId` and got it right, which is how the omission showed up.
- **The border drift ignored non-aggression pacts and alliances.** Phase 7
  refuses the _player_ an attack on a partner (§6.9) while the world went on
  taking a province off that same partner every time the sweep landed on their
  border. A promise the world breaks on your behalf is not worth the 75 trust
  it costs to break yourself. Removing the drift settled this one by deleting
  its subject, and `combat.ts` now calls off a standing attack the moment a
  pact is signed — the promise holds in the only place it matters.

**And four in the trade arithmetic**, all of them the same shape — a number
that was right on its own and wrong in company:

- A partner who could not deliver still had its full bill counted against the
  buyer's points, which rationed the buyer's _world-market_ order — in exactly
  the situation §6.5 introduced the market for.
- Points _income_ was not counted towards what a nation could pay, so a nation
  with no civilian factories could not buy anything however much it sold. A
  hard block, which is what invariant 2 forbids.
- A buyer at `RESOURCE_CAP` paid in full for deliveries the reducer clamped
  away, every tick, for as long as the agreement stood — and agreements are
  indefinite, so that state is one the design walks into rather than an
  accident. Flows scale to the room on the shelf now.
- Only one trade agreement per pair of nations was possible, in one direction,
  because the duplicate check compared the parties as a set. Two nations who
  wanted to swap steel for oil had to use the market at four times the price.

**Plus:** received offers counted against the _receiver's_ agreement limit, so
two dozen unanswered offers could lock a nation out of proposing anything of
its own; `accept_agreement` did not re-check the dead-partner rule; the economy
panel showed gross construction while the queue spent the net figure, making
its "days left" wrong by exactly the trade balance; and the diplomacy panel
filed every standing flow under "world market".

**Three gates had to be repaired to prove the fixes**, and each was measuring
its own luck rather than the world:

- **Phase 3 chose the largest nation**, which on a _young_ world is also the
  one sitting on the most mines — sixteen factories against 2.87 steel a tick
  mined, and a cap of twenty that could never have closed the gap. It picks
  within a band now: enough deposits that a shortage is a fraction rather than
  a wall, few enough that twenty factories can outrun them. The first attempt
  overshot into a nation with _no_ steel at all, where sufficiency is zero and
  the check that output ran "at the share of demand covered" divided by
  nothing — which is the other end of the same band.
- **Phase 3 also sampled progress instead of reading it.** Its wait loop polled
  every 100 ms on a world ticking every 50, so it saw about half the ticks, and
  a rich nation finished the factory inside twenty _samples_. It walks the tick
  history the client already keeps now: 126 ticks observed where it used to
  scrape 17.
- **Phase 1's kill landed on a snapshot boundary.** It waited a fixed twenty
  ticks after its last command, the snapshot at that exact tick became the
  durable record, and the world came back at the very tick the client had last
  seen — nothing to replay. It now waits until the world is between `margin`
  and one snapshot interval past _the record itself_, and kills inside that
  window.
- **Phase 5 could not be run twice on the same world.** A tech is kept for
  good, so the second run picked the nation it had taught the first time,
  measured a base factory rate that was already ten percent high, and was
  refused the research it came to watch. It picks a nation that does not know
  the tech yet, and says so when every nation does.
- **Phase 1's kill kept landing on a snapshot.** The window was measured from
  the durable record, and when that record was the last _command_ the next
  snapshot could arrive twenty-two ticks later and become the record instead —
  so the world came back at a tick the client had never seen. The kill now has
  to fit between the record and the next snapshot, both computed from
  `/health`.
- **Phase 6 could not find a nation with two military factories.** It needs
  two to run a rifle line and an artillery line at once, every nation starts
  with exactly one, and since the drift was removed an unattended world does
  not develop — so no nation was ever going to grow one. It builds the second
  itself now, trying several provinces because a capital is usually out of
  slots. That is what a player would do, and it is the first thing in this
  project that had to be built _because_ the world stopped moving on its own.
- **Phase 7 offered a trade to a nation whose warehouse was full.** Since the
  cap fix that moves nothing, correctly, so the gate now checks the buyer has
  room before choosing it — on a world a few hours old, a resource nobody
  consumes is sitting at `RESOURCE_CAP`, which makes this the ordinary case
  rather than an edge.

**One finding is not fixed, and it needs a decision rather than a patch:** a
session may claim _any_ nation in its `hello`. There is no account, no token,
and two sessions may hold the same nation. That has been true and documented
since phase 1, but phase 7 changes what it is worth: an impostor now reads the
private terms of that nation's treaties (§7 says only the two parties may) and
can cancel its agreements, which spends trust that nation can never earn back.
Accounts are the fix and they are their own piece of work.

### From phase 7

**`WORLD_TICK_MS` does not survive a `docker compose up` from inside a gate.**
The compose file reads it from the environment, so a gate that restarts the
world with `compose("up", "-d", "world")` brings it back at five seconds a
tick — and then waits on an in-game day that has quietly become two real
minutes. Every check before the restart passed and the run then timed out
somewhere that had nothing to do with the failure. Both gates that restart the
world now pass the clock through explicitly, and the phase-7 gate re-reads
`tickMs` from `/health` afterwards and refuses rather than hanging.

**A restore replays the command log up to its last command, and no further.**
`WorldRunner.restore` steps from the snapshot tick to the tick of the last
command in the log — so anything a _system_ did after that is rolled back by a
kill, and then happens again, deterministically, on the way back up. That is
CLAUDE.md §4's "maximum data loss on a hard crash is five minutes of
simulation" working as designed, and it is not a bug. It does mean a gate
cannot kill the world to prove that a system-produced change stuck: the
phase-7 counter-proof now waits for a snapshot to carry the dissolution first.

**The phase-1 gate could not see a replay at fifty milliseconds a tick.** It
connected its checking client after `/health` said the world was back, which
is half a second and ten ticks too late, and then reported that nothing had
been replayed. It knocks on the socket from the moment the container is told
to start now, and catches twenty-one replayed ticks where it used to catch
three. Two more things came out of the same run: the pre-kill window has to
stay **shorter than the snapshot interval**, or a snapshot lands after the
last command and becomes the durable record; and the resume check now says
"whichever of the two is later", which is what decision 0005 always said.

**A player's first command is no longer seq 0 in its tick.** The socket layer
writes a `nation_present` command when a session connects (decision 0011), so
it takes the first slot. The phase-1 gate asserted on `tick:0:nation:province`
and went red the day phase 7 landed — the command was in the log, one column
across. It matches on tick, nation and province now, which is what it was ever
trying to say.

**A production line could not be stood down once its factories were gone.**
Found by the phase-4 gate on a world where the drift had taken three of six
factory provinces: `assign_factories` compared the whole nation's holdings
against everything already assigned, so a nation holding three factories with
four assigned was refused _every_ order on that line — including
`factories: 0`, the order to give them back. The player is walled in by
arithmetic on the one screen where they were reacting to losing a province.
Only an increase has to fit now, and `tests/server/Production.test.ts` holds
the case. This predates phase 7 by two phases and was only reachable on a
world old enough to have lost something.

**An offer to a nation nobody has ever played is a dead letter.** §6.5's
dead-partner rule dissolves an agreement whose partner has been silent for a
fortnight, and a nation nobody has connected as has been silent since tick
zero — so the first version of this accepted the proposal, applied it, and
swept it up in the same tick. From the player's side that is indistinguishable
from the order being lost, which is exactly what §7 is written against. It is
refused at validation now, with a reason that says why.

### From phases 4 to 6

**Changing the state hash makes every running world refuse to start.** Adding
research to `stateHash()` meant the snapshot on disk no longer hashed to what
was recorded with it, and the world stopped with "the stored state is damaged".
Nothing was damaged; the function had changed. Locally the answer is
`docker compose down -v`. On a live season there is no answer yet — see the
open question above, and think about it before deploying into one.

**The world is persistent, and so is a gate's own mess.** The phase-4 gate
passed, and then failed twice in a row with "you hold 6 military factories, 4
of them already on other lines" — its own production lines from the previous
run, still holding the factories it wanted. Every gate that creates state now
sweeps first. Note that disbanding a division does **not** return its manpower,
so a back-to-back run has less to spend than the one before it; say so rather
than stalling on refused commands.

**Bumping `PROTOCOL_VERSION` while a gate chain is running breaks every gate
after it.** Self-inflicted, and it reads exactly like a real finding: three
gates in a row died with "client speaks 7, server speaks 6". The gate scripts
restate the version because they are `.mjs`; the running container does not
reload. Finish the chain, then bump, then rebuild.

**`npm run lint | tail` reports the exit code of `tail`.** This file has warned
about the shape twice — `build-prod | tail` in phase 0, `; echo $?` in phase 2
— and it happened again anyway, reporting "LINT CLEAN" over a real error. There
is no safe way to pipe a command whose exit code you care about. Redirect to a
file and check `$?` on the next line.

**eslint's `allowDefaultProject` aborts the whole run at nine matched files.**
Adding the seventh gate script produced "Too many files (>8) have matched the
default project" and **no lint output at all** — the same shape as the
four-exclusion-list trap. The gate scripts are in `tsconfig.json`'s `include`
now, which has no cap. That needs `allowJs`, which then needs `noEmit`, or both
linters refuse the project because it could overwrite its own inputs.

**A test that measures a fight has to exclude everything else that hurts.** The
first supply test raised a division at the capital, stepped the world fifty
ticks and asserted its strength was unchanged. It read 0.9025 — which is 0.95
twice, two border clashes, and nothing to do with supply. A system under test
gets called directly; `world.step()` runs all of them.

**And the reverse, once phase 6 landed:** combat stopped being the only thing
that empties a division. The phase-4 gate now ignores strength falls smaller
than 4%, because attrition is at most 2% a tick and a clash is 5% or 8%. Any
gate that attributes a loss has to know every other way that loss can happen.

**A gate that waits on a total waits on history, not on itself.** The phase-4
gate waited for "500 rifles and guns between them" before raising divisions.
On a world where earlier gates had already left two and a half thousand rifles
in the warehouse that condition was true before the gate produced anything, so
it stopped after the two hundred and fifty ticks its efficiency ramp needed —
and two factories on artillery make about twelve guns in two hundred and fifty
ticks. A division is 100 rifles **and 12 guns**, and strength is the worst
ratio across the template, so a stockpile of 2,460 rifles and 12 guns equips
exactly one division. It now waits on the number it actually needs — how many
divisions the stockpile could equip — which is self-correcting whatever the
world was holding when it started.

**A check written against your own setup breaks on somebody else's world.** The
phase-4 gate asserted the fight had spent half the warehouse. On a world where
earlier runs had left twenty-five thousand rifles lying about, six divisions
were never going to. It now measures the spend against what a division is made
of, which is true whether the nation is rich or empty.

**A gate that cannot use the world should say so, not fail.** The phase-6 gate
walked only provinces the nation both owned and held, and on a four-thousand
tick world — where ownership still lags control by `OCCUPATION_TICKS` — found
seven. That is the gate failing rather than the world. It now walks controlled
ground, like the server does, picks the deepest nation rather than the biggest,
and exits 2 with an explanation when no nation is deep enough.

**A gate can find a bug before it runs.** Designing phase 5's measurement
around `outputPerTick` meant reading how the server computes it — and it
computed it from the `MILITARY_FACTORY_OUTPUT` constant, not the researched
rate. The simulation was right and only the wire was lying, so no test would
ever have caught it and the symptom would have been a player insisting the
numbers do not add up.

**A determinism test with a default timeout fails under load.** Partitioning
1.2 million tiles twice takes six seconds on a machine that is also building a
Docker image — which is exactly when a phase is being closed. It has a real
timeout now, with the reason next to it.

**A gate run is five to fifteen minutes, and a stalled-looking one usually is
not.** Check `ps -eo pid,etimes` before concluding anything: elapsed seconds
are the ground truth, not how many times you have looked at the log. Two gates
were killed and restarted in this session for being "stuck" at two and three
minutes into normal runs, which is how two chains ended up competing for the
same nation and writing into the same file.

**Killing a gate by pattern kills the chain that started it.** `pgrep -f
"phase[0-9]-gate" | kill` found the gate and also orphaned the shell script
running the sequence, which died with 144 and took the remaining gates with
it. The same family as the `pkill -f` traps below, from yet another direction.
Kill the one pid you mean, or stop the task.

**Patching by string match after prettier, again.** Three patches this session
matched nothing because prettier had reflowed the lines. Every patch asserts
its pattern matched before writing, and each time the assertion fired the file
was left untouched — which is the whole point. Do not remove those assertions.

**`vite.config.ts` imports from `src/`.** It pulls `src/shared/util/AssetPath`
and `src/build/PublicAssetManifest` at _config evaluation time_ — before a build
**and before the tests**. Delete or move either without fixing the config first
and the whole toolchain dies with an error pointing at the wrong file.
(Both used to live in `src/core` and `src/server`; that is why they moved.)

**A type-only import is a real edge.** It vanishes from the bundle, not from
`tsc`. `render/gl/Renderer.ts` measured 56 core files with zero `src/core`
imports, purely through `client/Utils.ts`; and `i18n/Translate.ts` still
measured 56 after the split, because it named `LangSelector` in one type
annotation. Where only a few fields are read, type them structurally — that is
how three of the nine couplings were resolved. Measure from
`render/gl/Renderer.ts`, not just from `FrameData.ts`: the latter is the
narrowest thing you can measure and it read 0 while the real graph read 56.

**`tsconfig`'s `exclude` does not cut an imported file out of the program.**
It only drops it from the root set. Quarantine takes effect when nothing
outside imports the file — the config entry is bookkeeping, not enforcement,
so the gate for it has to be a test.

**`npm run gen-maps` writes to a path hardcoded in Go.** `map-generator/
codegen.go:262`. Move `Maps.gen.ts` in TypeScript and forget that line, and
everything stays green until someone regenerates — at which point the
generator writes a fresh catalog where nothing imports it and the real one
goes stale. `tests/architecture/GeneratedMapCatalog.test.ts` now guards it,
because this machine has no Go toolchain to run the direct check.

**`src/client/vite-env.d.ts` is a global script, not a module.** The
`declare module "*.bin"` blocks make it one, and `declare global` only takes
effect inside a module. Declare `interface Window` directly, and use inline
`import("...")` types — a top-level import turns the file into a module and
silently switches the `*.bin` declarations off.

**The renderer contract is bigger than `FrameData`.** The constructor requires
a `RendererConfig` (map dimensions, unit types, **and the player list**), a
palette array, and a `RenderRules` (seven methods — see
`render/types/Renderer.ts`). Territory colour comes from the palette indexed by
owner id — not from `frameData.players`. Also: `revealedRailTiles` is a
required field, and `events` needs three empty arrays, not an empty object —
`Upload.ts` reads `.length` before checking anything.
`client/world/FrameAdapter.ts` now satisfies all of it in one place, with a
test per trap; copy from there rather than from memory.

**`preloadAtlasData()` must be awaited before `new MapRenderer(...)`.**
`NamePass` and `StructureLevelPass` parse the MSDF atlas in their
constructors and throw "Atlas data not loaded" otherwise. It is not in any
type signature, so nothing warns you.

**The palette has two rows.** `Float32Array(4096 * 2 * 4)`: row 0 is fill at
`smallID * 4` (alpha 150/255), row 1 is **border** at
`4096 * 4 + smallID * 4` (alpha 1). Fill only row 0 and territory is coloured
while every border is black.

**The renderer runs its own animation loop, and needs to.** Do not pass
`raf`/`caf` — `GPURenderer` starts one in its constructor, and supplying a
capture gives two. It is also not optional: `TerritoryPass` drains one drip
bucket per rendered frame (nine of them), so a tile delta needs nine frames
to land. Drawing once per server tick leaves territory looking frozen.

**Take the camera's initial framing from the renderer**
(`MapRenderer.getCameraState()`), do not recompute it. `Camera.fitMap()` works
in device pixels (`cssWidth * dpr`) and leaves a 10% margin, so a controller
measuring `clientWidth` lands elsewhere on any display with `dpr != 1` —
visible as a map pushed off-centre and clipped on one side.

**`tsconfig`'s `exclude` does not cut an imported file out of the program.**
It only drops it from the root set; one import from a live file pulls the
whole excluded subtree back in, and everything that subtree imports. The
quarantine is held by `tests/architecture/QuarantineBoundary.test.ts`, not by
the config entry. The same applies to the four exclusion lists (tsconfig,
vitest, eslint, oxlint): they have to change together, or a file lands in no
tsconfig project and both linters abort with "not found by the project
service" instead of reporting anything.

**A guard test needs its own self-test.** The first version of the quarantine
scanner passed against a deliberately planted violation. Every part checked
out in isolation — the walker found the file, the matcher found the import,
the paths resolved — and it still reported nothing. It now asserts, on every
run, that it detects a planted violation, and its fixture is built from
template literals so the file does not violate the rule it enforces. Verify a
new guard by breaking something on purpose, not by reading it.

**`vite-plugin-html` binds the dev server to one entry.** Adding a second HTML
page to compare old and new side by side does not work: every path serves
`index.html` with the configured entry. Switch `index.html` and the plugin's
`entry` together, or not at all.

**One long-lived tile buffer, mutated in place.** `TrailPass` keeps the array
reference and reads it at draw time. A fresh array per tick renders the first
frame and then silently ignores every update. Assert buffer _identity_ in
tests, not equality.

**`systemctl reload nginx` lies** (relevant from phase 12). Covered in
[`docs/deploy/README.md`](docs/deploy/README.md).

### From phase 4

**Moving a rule into a system takes its context with it.** The border drift
carried one guarantee since phase 1: it never touches a province a command
moved in the same tick, because a heartbeat that can undo an order is
indistinguishable from the order being lost. Moved out of `World` and into
`systems/combat.ts`, it lost that — a system cannot see the tick's commands.
`provinceHeldSince === tick` restores it exactly, needs no new state, and the
existing test caught the regression on the first run.

**Patching a file by string match fails silently once prettier has been through
it.** Three separate edits to the same test file matched nothing tonight, and
the third time it cost half an hour spent debugging a fix that had never been
applied. Every patch now asserts that its pattern matched; a file needing more
than two gets rewritten instead.

**A reset observed in the same tick is not a reset to the floor.** Commands
apply before the systems run, so a production line switched on tick N is reset
_and then climbs one step_ before anything can look at it. The test asserts "at
most floor plus one gain", which is the honest statement of the rule.

**Manpower can sit above its own ceiling for a tick.** The economy reads the
cap, then the combat system takes a province later in the same tick and lowers
it. The pool is cut on the next tick. A test that asserts the invariant every
tick fails on a true statement; assert it against the highest ceiling the run
has had.

### From phase 3

**A command validated at arrival is validated against a world its own
siblings have not touched yet.** Three build orders sent in the same five
seconds were each checked against the queue as it stood _before_ any of them
were applied, so all three were acked "accepted for tick N" — and the third was
then silently skipped when the tick ran, because by then the slots were full.
That is precisely the failure CLAUDE.md §7 exists to prevent: the player sees
nothing happen and cannot tell a refused order from a lost packet. Validation
now counts commands already accepted for the coming tick as well as orders in
the queue.

**A queue position is not a name.** Cancelling by index cancelled the wrong
thing whenever two cancellations landed in the same tick: the first shifts the
queue and the second removes whatever slid into that slot — or is refused as
out of range, leaving an "accepted" ack and the order still sitting there.
Construction orders now carry an id, assigned by the reducer so a replay hands
out the same ones, and never reused.

**A test written to catch a bug has to be run against the bug.** The first
version of the test for the first of those two used `naval_base` as one of its
three buildings; the inland capital refused it for its own reasons, so only two
were ever accepted, the counts matched, and it passed with the fix switched
off. Three separate string edits meant to correct it silently matched nothing,
because prettier had reformatted the lines they were looking for. The rule that
comes out of it: after editing a file by pattern, **check that the pattern
matched** — and prove a new test by disabling the fix, not by reading it.

**`npm run test` does not run the Postgres tests, and they rot.** They are
`describe.skipIf(!TEST_DATABASE_URL)`, so a green suite says nothing about
them. Phase 2 split a province's owner from its controller and updated every
assertion in `Restore.test.ts`; `PgStore.test.ts` asserts the same things
against a real database and was still checking the phase-1 shape a day later,
because nothing ran it. **`npm run test:db` is part of finishing a phase**, not
an optional extra — and it is the only thing that runs the migrations.

**`.gitignore` had `*.sql`, so no migration was ever in the repository.**
Inherited, and aimed at database dumps, which contain password hashes — it also
matched `drizzle/*.sql`. `drizzle/meta/_journal.json` listed two migrations
whose SQL was not committed, and a fresh clone would have started a world
against a database with no tables in it. Nothing failed locally, because the
files were on the disk of the machine that generated them. This is the second
inherited ignore rule to silently swallow new files tonight, after `build/`
matching `src/build/`; when adding the first file of a new kind, check
`git log -1 --stat` rather than trusting `git add -A`.
`tests/architecture/MigrationsAreTracked.test.ts` now asserts that every
migration the journal names is **tracked by git**, not merely present on disk —
existence is exactly the check that would have passed against the broken state.

**The terrain hash does not identify a world.** The `worlds` table recorded the
map and its terrain hash, and a regenerated artefact over _unchanged terrain_ —
a fix to the partition, a tuned number in `shared/config/provinces.ts` — passed
every check and then meant something different by every province id in the
command log. The snapshot check catches it once a snapshot exists; before tick
60 there is none. `partition_hash` is now a column, checked on every start, and
backfilled for a world created before it existed.

**`pkill -f` matches the shell you typed it in — including through a heredoc.**
This file already warned that `pkill -f "Main.ts"` kills its own shell. It
happened again anyway, from a new direction: a command that ran
`pkill -f 'phase3-gate[.]mjs'` and _then_ patched a file whose name appears in
the same command line. The bracket does not help — `[.]` matches `.`. The whole
command died at the first step, silently, and the twelve minutes after it were
spent wondering why a patch had not applied. Kill by pid, or by container.

**An accepted command takes effect on the _next_ tick, so the queue is still
empty when the ack arrives.** A gate that queued a building and then waited for
"the queue is empty" returned instantly, queued sixteen orders in a second, and
measured the demand of the three that happened to have finished. Wait for the
thing to appear before waiting for it to be gone.

**A gate that waits for the world to reach a state will wait forever.** The
border drift moves a province every tick, so a nation built to exactly its own
extraction loses a mine or a factory and drifts back into balance — measured,
with steel demand falling from 1.40 back to 0.80 while the gate watched. Play
the world into the state you want to measure, with margin, rather than waiting
for it: the phase-3 gate builds twelve military factories against a target of
two and a half times extraction.

**`; echo "exit=$?"` reports the echo, not the command.** The same shape as the
`build-prod | tail` trap from phase 0. A gate run as
`node gate.mjs > log 2>&1; echo "gate=$?"` reported success while the log held
a stack trace. Write the exit code into the log from inside the redirection.

**An empty environment variable is not an unset one.** `docker-compose.yml`
passes `WORLD_TICK_MS: ${WORLD_TICK_MS:-}`, which sets it to the empty string
when it is not supplied. `??` does not catch that and `Number("")` is 0 — a
world with no delay between ticks at all. Parse it, do not coalesce it.

**A shared fixture that a test mutates is an order-dependent suite.** Two of
the economy tests strip a province's deposits to force a shortage. With one
module-level `ProvinceMap` they passed, and would have failed the day somebody
added a test above them. Building the map per test costs two milliseconds.

**A `Uint8Array` wraps at 256 without complaint.** Nothing in the building
counts can reach it — slots cap at ten — but the saturating add costs nothing
and a wrapped building count is the kind of bug that looks like a UI fault for
an hour.

**Rounding a float into a hash makes the hash lie.** The state hash grew to
cover stockpiles and construction progress, which are doubles. Rounding them to
three decimals would leave a world that came back 0.0001 short hashing
identically to the one that left — and the restore gate's whole content is that
hash. Both words of the double go in, through a shared `Float64Array` view.

### From phase 2

**`.gitignore`'s `build/` also matches `src/build/`.** An unanchored pattern
matches at every level, and `src/build/` is source — `PublicAssetManifest.ts`
only survives there because it was already tracked when the pattern arrived,
and gitignore does not apply to tracked files. The next file added beside it
was staged as part of a full `git add -A`, reported nothing, and was simply not
in the commit. Anchored to `/build/` now. Worth a `git log -1 --stat` after any
commit that adds a file to a directory you have not added one to before.

**A gate script that restates a constant will eventually restate it wrong.**
`scripts/phase1-gate.mjs` is `.mjs` and cannot import `PROTOCOL_VERSION`. Left
at 2 when the wire went to 3, it stopped at "the world refused the connection"
— the gate failing rather than the world, which is the most expensive way for a
gate to fail because it looks like a real finding.
`tests/GateProtocolVersion.test.ts` reads the line out of each gate and
compares it.

**`; echo "exit=$?"` reports the echo, not the command.** The same shape as the
`build-prod | tail` trap from phase 0, from a different direction: a gate run
as `node gate.mjs > log 2>&1; echo "gate=$?"` reported success while the log
held a stack trace. Write the exit code _into_ the log from inside the
redirection, or check `$?` with nothing between.

**Sea zones are the ocean, not the water.** The terrain byte distinguishes
ocean from inland lakes. Flooding sea zones over everything that is not land
gave landlocked provinces a sea zone and no coastline — caught only because a
test asserted `seaZone !== null` implies `coastal`. A lake is not a theatre.

**A zone grown to a distance is not a zone grown to a size.** A multi-source
flood equalises _radius_: every province joins the nearest seed. Provinces are
not uniform, so on Europe that gave air zones of 2 and of 43 against a target
of 22, and Lloyd relaxation barely moved it — the shape of the graph, not the
placement of the seeds, was the problem. Growing every zone one province per
round until it hits a quota equalises the count, which is what §6.7 actually
asks for. Two earlier attempts are recorded in the comment above
`partitionAirZones` so nobody tries them again.

**Merging a group into "the smallest neighbour" has two traps.** A group that
was already merged away has an empty member list, and empty is the smallest
there is — it wins every comparison and the provinces are handed to a group
that no longer exists. And picking the _lowest-numbered_ neighbour instead of
the smallest piles every stranded piece of a region onto one zone.

**A test with one `expect()` per tile does not finish.** The first version of
the artefact test asserted per tile over 1.2 million tiles and hit vitest's
5-second timeout. Aggregate into counters and assert once; the failure message
is better anyway.

**The occupation timer cannot be tested by taking a province and waiting.** The
border drift moves a province every tick, so a scripted take-and-wait spends
its time on whichever nation happened to be adjacent on tick 300. Stated as an
invariant over a long run — no owner change is ever less than
`OCCUPATION_TICKS` after that province's last control change — it holds
regardless, and it caught nothing spurious.

### From phase 1

**A Postgres advisory lock lives and dies with its connection.** Taken on a
pooled connection, its lifetime is the pool's business — and a pool is entitled
to close an idle connection. `PgStore` keeps one client outside the pool for
the life of the process, does nothing else with it, and stops the server if it
drops. Two containers ticking one world both append to its command log, and
afterwards the log describes a run neither of them had. There is no repair.

**`npx tsx` runs the server as a grandchild.** `pgrep -f Main.ts` finds the
`sh -c`, the `tsx` wrapper and the real node process, in that order, so killing
the first hit leaves the world ticking. The second server then starts, is
refused by the advisory lock, and exits — the lock demonstrating itself from
the wrong end. In a container the world is PID 1 and `docker kill` has no such
gap, which is one reason the gate runs against the container.

**And `pkill -f "Main.ts"` kills the shell you typed it in**, because that
shell's own command line contains the pattern. Match on the process's actual
binary, or use the container.

**`prettier --write src` reformats the quarantine.** `src/client/_legacy/` is
excluded from tsconfig, vitest and both linters, but not from prettier, so a
broad format pass produces a dozen unrelated modified files in the middle of a
commit. Format the paths you touched.

**A new config file at the repository root must join `tsconfig.json`'s
`include`.** `drizzle.config.ts` did not, and both linters aborted with "not
found by the project service" instead of reporting anything — the same shape as
the four-exclusion-list trap, from the other direction.

**The restore resumes at the last durable record, not at the tick it died on.**
Snapshot at 120, command at 135, killed at 137 → it comes back at 135. That is
the guarantee the design makes (decision 0005) and the restore test asserts it
in that form. The first version of that test asserted 137 and failed, which was
the test being wrong, not the code.

**A test fixture map needs to be big.** Provinces are cut at roughly 900 tiles,
so a 180x60 fixture gives three nations one province each: every "does this
province border mine" test is then vacuously true or impossible, and the border
drift eats the world inside thirty ticks. `tests/server/Restore.test.ts` uses
320x140 with five capitals for 48 provinces, and says why.

**An overlap test has to hold a tick open.** The first version of
`TickLoop.test.ts` checked for concurrent `onTick` calls with a flag, and did
not catch an unawaited tick: the callback's synchronous part finished before
the next invocation, so the flag was never set when it mattered. It now blocks
tick 1 on a promise the test releases, and fails as it should.

**A memory store that returns its own arrays is not a store.** `MemoryStore`
`structuredClone`s on the way in and out. Without that, a test can mutate what
it just "persisted" and every restore assertion passes for the wrong reason.

**`npm run build-prod` was failing silently for the whole of phase 0.** Its
last step hashed `src/core`, which phase 0 deleted, and died with `ENOENT`. Two
things hid it: the step runs after vite, which had already printed a clean
build with all its sizes; and the usual way of running it —
`npm run build-prod | tail` — reports the **pipe's** exit code, not the
command's. Check `$?` on the command itself, or do not pipe it.

**The browser leg is unverified, and stays that way.** The world's socket
is proven three ways — `curl` gets `101 Switching Protocols` through the Vite
proxy on port 9000, a node client completes the handshake through the same
proxy, and `scripts/phase1-gate.mjs` plays a whole game over it. What has not
been seen is the map in a browser: in an automated Chrome the page's own
WebSocket to `/ws` fails immediately while Vite's HMR socket on the same origin
connects, which points at the automation rather than at the code, but points at
nothing conclusively. **Open `http://localhost:9000/?nation=<n>` by hand before trusting the client
half of any phase.** There is a five-point checklist at the top of this file
for exactly that. Everything else in this project is proven by a script; this
is the one thing that is not, and pretending otherwise is how a phase gets
called done on a blank canvas.

**A gate that hardcodes a nation eventually fails on a healthy world.** The
border drift redraws the map over hundreds of ticks and can wipe a nation out
entirely; `scripts/phase1-gate.mjs` used to ask for nation 1 and reported
"could not claim anything" after 524 refusals. It now connects as a spectator
first and plays whichever nation holds the most provinces.

**A green test can be worse than a red one.** When background music was
removed, one test's assertion body stopped running — it would have passed while
checking nothing. It is `it.skip` with a comment, not "fixed". Watch for this
shape whenever you remove data that a test iterates over.

---

---

## Where the plan lives

The implementation plan is a working document, kept outside this repository
because it is per-machine and parts of it discuss a specific deployment host.
`CLAUDE.md` is the authoritative public specification; a plan is only the route
to it.

**It does not travel between machines, and phase 1 was planned twice because of
that** — the phase-0 plan lived at `C:\Users\maxob\.claude\plans\` and was not
there when the work moved to a Linux machine. Nothing was lost: `CLAUDE.md` §8
and this file were enough to reconstruct it. That is the arrangement working as
intended rather than a mishap, but it is worth knowing before you go looking
for a file that is not coming.

## Working agreements

- **Questions to Max are always multiple choice**, never open-ended — with the
  recommendation first and each option saying what it costs.
- **Commit as you go, directly on `main`.** Conventional commits, phase number
  in the body. Do not push without asking.
- Each phase ends the same way: invariant tests → lint + typecheck →
  `/code-review` over the diff → `/verify` by actually running it → deploy →
  only then is the gate passed.
- Docs are updated in the same commit as the change. Decision records are
  written when the decision is made, never edited afterwards.
- **Nothing private in this repository.** It is public and stays public. Host
  specifics live in git-ignored `*.local.md` files.
