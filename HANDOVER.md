# Handover — state of the work

**Written 2026-08-30.** Read this first if you are picking the project up
without context. It says where the work stands, what to do next, and which
traps have already been paid for.

- **What this project is:** [`README.md`](README.md)
- **The design, in full:** [`CLAUDE.md`](CLAUDE.md) — every system, the 11 build
  phases, and the gate each has to pass
- **Why things are the way they are:** [`docs/decisions/`](docs/decisions/)
- **How the code works right now:** [`docs/architecture/`](docs/architecture/)

---

## Where we are

**Phase 2 of 11 — the province graph. Complete.** Europe is 529 provinces, and
each of them now knows its terrain, infrastructure, building slots, resource
deposits, air zone and sea zone. All of it is **generated once and checked in**
next to the terrain bytes rather than recomputed at startup, so a generator fix
can no longer repartition a running season (decision 0006). A province has a
**controller** and an **owner**: control moves the tick it is taken, ownership
follows a fortnight later. The client loads the same artefact, colours the map
by controller, and draws province borders as an overlay you can toggle with
`b`.

Phase 1 underneath it is unchanged and still passes: a world ticks every five
seconds on an epoch-anchored deadline, writes every command to Postgres before
acting on it, snapshots every 60 ticks, and comes back where it was after being
killed.

**Start it with three commands:**

```bash
docker compose up -d # Postgres + the world, ws://localhost:3000/ws
npm run start:client # http://localhost:9000 (add ?nation=1 to play one)
curl -s localhost:3000/health
```

Without `docker compose`, `npm run start:server` still works: with no
`DATABASE_URL` the world keeps its history in memory and says so on the first
line.

### The gates, run rather than described

Both against `docker compose up -d`. **`node scripts/phase2-gate.mjs`**, last
run:

```
phase-2 gate
  artefact on disk: 529 provinces, partition 5a8a6c17, terrain bd09055c
  world world-0 at tick 67
  ok    the world runs the artefact on disk: 5a8a6c17 === 5a8a6c17
  ok    and the terrain it was generated from
  ok    529 provinces, on the wire and on disk
  ok    every one of 492907 land tiles carries its province's controller
  ok    no water tile carries a nation
  ok    no tile names a nation this world does not have
  nation 17 holds the most provinces (40)
  claimed province 400 for tick 68 (362 refused on the way)
  ok    the claim moved the controller of province 400
  ok    and left its owner alone — holding is not owning (decision 0002)
  ok    all 1284 tiles of province 400 now read nation 17
  ok    a world rebuilt from 4 deltas matches a fresh full state at tick 71
  ok    and agrees about ownership too
PASS
```

**And it was checked against itself being broken**, twice:

```
$ node scripts/phase2-gate.mjs --break=artefact
  FAIL  the world runs the artefact on disk: 5a8a6c17 === 5a8a6ce8   → exit 1

$ node scripts/phase2-gate.mjs --break=deltas
  FAIL  a world rebuilt from 4 deltas matches a fresh full state      → exit 1
```

Each breaks exactly one line and leaves the rest green, which is what makes
the green ones mean something.

The gate parses `provinces.bin` itself rather than importing the project's
decoder. That is deliberate: a gate that calls the same function the server
calls proves only that the function agrees with itself.

**What the phase-2 gate does not do is look at the screen.** CLAUDE.md §8 ends
its gate with "and the client renders it correctly", and this project has no
automated browser leg (see the trap below). Everything up to the pixels is
proven here; the pixels are the morning checklist.

**`node scripts/phase1-gate.mjs`** still passes unchanged after all of phase 2.
Last run, on a fresh world:

```
phase-1 gate
  world world-0 at tick 1, last snapshot 0
  nation 17 holds the most provinces (38)
  claimed province 401 for tick 2 (363 refused on the way, the rejection path)
  snapshot at tick 60
  claimed province 401 for tick 61
  SIGKILL to the world container
  the world came back, resuming at tick 61
  ok  resumed at the last durable tick: 61 === 61
  ok  the tick did not restart from zero (61)
  ok  the restored world passed back through 5 tick(s) this client had seen
  ok  every replayed tick hashes identically (61, 62, 63, 64, 65)
  ok  the late command is in the log: 61:0:17:401
  ok  the early command is still in the log: 3:0:17:401
  ok  the restored world reports healthy
PASS
```

The hash line is the one that matters. The client tracks province ownership
from the full state and the deltas and hashes it per tick with the same
function the server uses; after the restart the world replays back through
ticks the client already saw, and those hashes have to match.

**And the gate was checked against a broken restore**, because a gate nobody
has seen fail is a gate nobody should believe. With the replay altered to skip
the commands it loads, the same run gives:

```
  ok    resumed at the last durable tick: 61 === 61
  ok    the tick did not restart from zero (61)
  ok    the restored world passed back through 5 tick(s) this client had seen
  FAIL  ticks that replayed differently: 61, 62, 63, 64, 65
  ok    the late command is in the log: 61:0:17:401
```

Every other check passes. A restore that produces a _plausible_ world rather
than _the_ world is caught by exactly one line, which is why that line exists.

| Commit     | What                                                              |
| ---------- | ----------------------------------------------------------------- |
| `698d8196` | `shared/config/time.ts`; strict TypeScript for shared + server    |
| `654dc704` | **The tick loop: absolute deadlines, awaited, epoch from resume** |
| `8864eedb` | Protocol v2 — commands, acks, nation identity, claim by click     |
| `3ce25211` | **Snapshots, command log and replay behind a store interface**    |
| `fb031e5b` | Postgres via Drizzle, advisory lock on its own connection         |
| `bb5b17da` | `/health` on the socket's port                                    |
| `ebc5838b` | World image, compose stack, the gate as a script                  |
| `bd005f66` | Upstream's match-server deployment chain deleted                  |

Phase 2:

| Commit     | What                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `5e304481` | **The partition becomes checked-in map data**, with its generator and the guard test      |
| `6dccc55b` | **Artefact loading on both sides, control/owner split, border overlay, the phase-2 gate** |

Phase 0's commits are in the history of this file before this rewrite.

### The whole plan, and how far along it is

Three of twelve gates passed. The gate is the unit of progress here, not the
code: a phase is done when its gate has been demonstrated, not when it
compiles.

| Phase                          | Gate                                                                                | State                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 0 · Fork triage                | The inherited renderer draws a map from server-pushed state, no client simulation   | ✅ passed                                                          |
| 1 · World persistence          | Kill the container mid-run; it resumes at the correct tick with no lost commands    | ✅ passed                                                          |
| 2 · Province graph             | A province changes hands, ownership propagates from tiles, the client renders it    | ✅ passed server-side; the rendering half is the morning checklist |
| 3 · Factories and construction | Queue a factory, watch it build over ticks, see output rise; shortage degrades it   | ⬜ next                                                            |
| 4 · Production and equipment   | A sustained fight drains a stockpile; switching a line costs output for a long time | ⬜                                                                 |
| 5 · Research                   | A completed tech measurably changes a production or combat number                   | ⬜                                                                 |
| 6 · Supply                     | An overextended offensive stalls from supply alone; full recompute under 50 ms      | ⬜                                                                 |
| 7 · Diplomacy and trade        | A trade agreement survives a season restart with no renewal from either player      | ⬜                                                                 |
| 8 · Air zones                  | Air superiority in a zone measurably shifts a ground battle there                   | ⬜                                                                 |
| 9 · Naval zones and convoys    | Cutting convoy routes starves a province _and_ cuts trade income, with no land war  | ⬜                                                                 |
| 10 · Regent                    | 2,000 ticks under regent control against an active opponent, capital still held     | ⬜                                                                 |
| 11 · Deployment                | Seven uninterrupted days on the deployment host, one verified snapshot restore      | ⬜                                                                 |

Phases 3 to 10 are the game. Phases 0 to 2 were the ground it stands on: a
renderer with no simulation behind it, a world that survives being killed, and
a map with provinces that mean something. From here every gate is something a
player could watch happen.

## What you have to look at yourself

Everything below is proven by a script. This is the part that is not, because
this project has no automated browser leg. Five minutes:

```bash
docker compose up -d
npm run start:client
```

Then open `http://localhost:9000/?nation=17` (or any nation number) and check:

1. **The map draws territory** — coloured regions, not a blank canvas.
2. **Province borders are visible** as dark seams inside each nation, and
   `b` turns them off and on again.
3. **Clicking a neighbouring province changes its colour**, and the notice in
   the bottom-left says the order was accepted for a tick.
4. **Clicking a province far away is refused**, with a reason.
5. **The map keeps moving on its own** — one province changes hands per tick.

If 1 or 2 fail, open the console: a map or artefact mismatch is thrown with
both hashes in the message, and a stale `provinces.bin` out of the HTTP cache
is the likely cause — hard-reload.

## What to do next

**Phase 3 is factories and construction.** CLAUDE.md §8 has the gate: a player
queues a factory, watches it build over ticks, sees output rise, and a resource
shortage degrades that output proportionally rather than blocking it.

It is the first phase that is a _game_, and the first with its own UI. The
order to build it in:

1. **The system framework first** (§6). `run(world, tick): Event[]`, a fixed
   order, and a reducer that applies events after every system has run. Phase 3
   fills `economy` and `construction`; the other slots exist empty so the order
   is the specification's from the start. This is the investment phases 4 to 10
   live on, and it is cheaper to get right now than to retrofit.
2. **`shared/config/rates.ts`** — every balance number, deliberately low.
3. **Buildings, the construction queue and resource extraction.** Invariant 1:
   everything is a rate. Invariant 2: shortage scales output down and never
   blocks. The second is what the gate actually tests.
4. **State growth.** Nation resources, construction queues and per-province
   buildings all go into `WorldSnapshot` _and_ into `stateHash`. A field left
   out of the hash is a field the restore test cannot see, and it will pass
   over a world that came back half right.
5. **Two new commands**, `queue_construction` and `cancel_construction`. That
   also settles the "a command set of one hides what the second one needs"
   worry from phase 1 without writing anything throwaway.
6. **The first own screen**, in `src/client/world/ui/` — outside `render/`, or
   the RenderBoundary test breaks. English source strings in `en.json` with the
   German alongside in the same commit. Per invariant 9, rates are shown **per
   in-game day**, never per tick.

Still worth doing, and still deferred:

- **The four pathfinding files that did not survive phase 0** (`PathFinder.ts`,
  `.Air`, `.Station`, `spatial/SpatialQuery`). They need a province graph,
  which now exists — but their real consumer is supply in phase 6, and writing
  them before there is anything to route would be guessing at the interface.
- **Water provinces.** Phase 2 partitions the ocean into sea zones and stores
  them in the spare bit of the tile array, which is what §6.7's zone
  abstraction needs. Phase 9 will want water _provinces_ as well; that is a
  `provinces.bin` format bump, and the format has a version field for it.
- **Deployment to a real host** (phase 11) and **accounts**. The nation still
  comes from `?nation=` in the URL.

## Traps already paid for

Things that cost time to find. Do not rediscover them.

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

**`systemctl reload nginx` lies** (relevant from phase 11). Covered in
[`docs/deploy/README.md`](docs/deploy/README.md).

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

## How to verify anything

```bash
npm run inst                                  # npm ci --ignore-scripts — never `npm install`
npm run typecheck                             # tsc over everything, must be clean
npm run typecheck:strict                      # tsc over shared/ + server/ with strict: true
npm run lint                                  # oxlint + eslint, must be clean
npm run test                                  # one vitest run; see baseline below
npm run test:db                               # the Postgres tests; needs `docker compose up -d db`
npm run build-prod                            # tsc + vite + asset hashing; the real integration test
npm run check:doc-links                       # every relative link in every .md resolves
npm run gen-provinces                         # regenerate the province artefacts (see below)
docker compose up -d                          # Postgres + the world
npm run start:client                          # http://localhost:9000/?nation=17
node scripts/phase1-gate.mjs                  # persistence, end to end, across a SIGKILL
node scripts/phase2-gate.mjs                  # the province graph, end to end
node scripts/phase2-gate.mjs --break=artefact # and it must fail
node scripts/phase2-gate.mjs --break=deltas   # and this way too
```

**`npm run gen-provinces` is not part of the build.** It writes map data into
the repository, and `tests/shared/ProvinceArtifact.test.ts` fails until the
result is committed. If you change `ProvincePartition.ts`,
`ProvinceAttributes.ts` or `shared/config/provinces.ts`, run it and commit both
halves — that friction is the whole point of decision 0006.

The last three are the ones that matter. A green suite says the pieces
type-check and their units behave; only running them shows a map, and only the
gate shows a world that survives.

### Test baseline

**437 passed, 7 skipped, in one run — no tolerated failures.** `npm run test` is
a single `vitest run`. The seven skipped are the Postgres integration tests,
which run under `npm run test:db` against `docker compose up -d db`; a unit
suite that needs a container is a unit suite people stop running.

That is a change of kind, not just of number. The two environmental failures
this document used to tell you to ignore — the de-DE thousands separator and
the InventoryModal timeout — went into quarantine with their subjects. The
rule is now **every failure is yours**, not every third one. If you are
looking for two red tests because you read an older version of this file,
stop looking.

The count moved from 412 at the end of phase 1, and from 4012 before that
because ~300 test files test code that no longer exists and are in
`tests/_legacy/`, excluded from the run. They were moved
rather than deleted: `AttackLogicGolden`, `tests/pathfinding` and
`MapConsistency` are effectively the world server's specification, and are
worth reading when the corresponding system gets built.

### Measuring the boundary

The probe that made phase 0 tractable — compile a file whose only content is
`import type { FrameData }`, count `src/core` entries in `tsc --listFiles` —
has nothing left to measure: `src/core` does not exist. What replaced it:

- `tests/architecture/RenderBoundary.test.ts` — the renderer imports nothing
  outside `render/` except `shared/`, `client/util/AssetUrl` and
  `client/i18n/Translate`.
- `tests/architecture/QuarantineBoundary.test.ts` — nothing live imports into
  `_legacy/`, and the four exclusion lists agree.
- `no-restricted-imports` zones in `eslint.config.js` for `render/` and
  `shared/`, so violations show up in the editor.

And the blunt one, which measures the artefact rather than the type graph.
After `npm run build-prod`:

```bash
ls static/assets/ | grep -i worker # nothing — the simulation is gone
du -h static/assets/index-*.js     # ~436 kB, was 2.3 MB
```

If a later change re-imports the simulation by some route the boundary tests
do not model, the worker chunk comes back and the bundle jumps. Worth reading
before trusting a green suite.

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

---

## Open questions

**Needs a decision before the world is deployed anywhere real** (phase 11 —
phase 1 deliberately stopped at a local stack):

- DNS record for the world's domain — who creates it, and by hand or via API.
- The deployment host had a pending reboot when this was last discussed. A
  persistent world should not be rolled out the week before one without
  agreeing how it drains first.
- **Accounts.** `?nation=1` in the URL is the whole of authentication. That is
  right for a local stack and unacceptable for a public one, and the tables
  belong with the registration screen rather than ahead of it.

**Answered in phase 1, recorded here so they are not reopened:**

- A world resumes at its last durable record, not the tick it died on
  ([decision 0005](docs/decisions/0005-resume-at-the-last-durable-record.md)).
- The border drift stays as the world's heartbeat. It is deterministic from
  (state, tick), so it replays exactly — which is also what makes the restore
  test hard enough to be worth running.
- `strict` applies to `shared/` and `server/` through `tsconfig.strict.json`,
  not to the inherited renderer. Measured when it went in: zero errors, the
  inherited `shared/map` and `shared/pathfinding` included.

**Deliberately deferred** (`CLAUDE.md` § 10 says to decide these only when they
block): season victory condition, manpower model, how new players enter a
running world, output of occupied provinces.

**Small and open:** the game UI language. The fork ships a complete German
translation and all inherited strings go through `translateText()`. Our own
screens from phase 3 need their own entries. Provisionally English as the source
language, German maintained alongside.

---

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
