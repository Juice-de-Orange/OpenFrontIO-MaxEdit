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

**Phase 1 of 11 — world persistence. Complete.** A world ticks every five
seconds on an epoch-anchored deadline, accepts validated commands, writes every
one of them to Postgres before acting on it, snapshots every 60 ticks, and
comes back where it was after being killed. `/health` says whether it is
actually moving. `src/core` and upstream's match server are gone, the rest of
the inherited client is quarantined, and the simulation is not in the shipped
bundle.

**Start it with three commands:**

```bash
docker compose up -d # Postgres + the world, ws://localhost:3000/ws
npm run start:client # http://localhost:9000 (add ?nation=1 to play one)
curl -s localhost:3000/health
```

Without `docker compose`, `npm run start:server` still works: with no
`DATABASE_URL` the world keeps its history in memory and says so on the first
line.

### The gate, run rather than described

`node scripts/phase1-gate.mjs`, against `docker compose up -d`. Last run, on a
fresh world:

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
  ok  the early command is still in the log: 2:0:17:401
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

Phase 0's commits are in the history of this file before this rewrite.

### The whole plan, and how far along it is

Two of twelve gates passed. The gate is the unit of progress here, not the
code: a phase is done when its gate has been demonstrated, not when it
compiles.

| Phase                          | Gate                                                                                | State     |
| ------------------------------ | ----------------------------------------------------------------------------------- | --------- |
| 0 · Fork triage                | The inherited renderer draws a map from server-pushed state, no client simulation   | ✅ passed |
| 1 · World persistence          | Kill the container mid-run; it resumes at the correct tick with no lost commands    | ✅ passed |
| 2 · Province graph             | A province changes hands, ownership propagates from tiles, the client renders it    | ⬜ next   |
| 3 · Factories and construction | Queue a factory, watch it build over ticks, see output rise; shortage degrades it   | ⬜        |
| 4 · Production and equipment   | A sustained fight drains a stockpile; switching a line costs output for a long time | ⬜        |
| 5 · Research                   | A completed tech measurably changes a production or combat number                   | ⬜        |
| 6 · Supply                     | An overextended offensive stalls from supply alone; full recompute under 50 ms      | ⬜        |
| 7 · Diplomacy and trade        | A trade agreement survives a season restart with no renewal from either player      | ⬜        |
| 8 · Air zones                  | Air superiority in a zone measurably shifts a ground battle there                   | ⬜        |
| 9 · Naval zones and convoys    | Cutting convoy routes starves a province _and_ cuts trade income, with no land war  | ⬜        |
| 10 · Regent                    | 2,000 ticks under regent control against an active opponent, capital still held     | ⬜        |
| 11 · Deployment                | Seven uninterrupted days on the deployment host, one verified snapshot restore      | ⬜        |

Phases 3 to 10 are the game. Phases 0 and 1 were the ground it stands on:
nothing in them is visible to a player, and both had to be right before
anything else could be built on top. From here every gate is something a player
could watch happen.

## What to do next

**Phase 2 is the province graph.** CLAUDE.md §8 has the gate: a province
changes hands, ownership propagates from tiles, and the client renders it
correctly. The pieces already half-exist, which is the trap — read what is
there before adding to it:

1. **Move the partition offline.** `computeProvincePartition` runs on both
   sides at startup, 368 ms for Europe. Phase 2 ships the result as a
   checked-in file, so a generator bugfix cannot repartition a running season.
   The invariants the tests assert — determinism, connectivity, no province
   spanning two nations — carry over unchanged.
2. **Give a province the fields the spec asks for**: terrain, infrastructure,
   building slots, resource deposits, air and sea zone membership. Today it has
   an owner and a neighbour list.
3. **Derive ownership from tiles**, rather than assigning it at partition time.
4. **Render province borders as an overlay.**

Worth doing in phase 2 while it is still cheap:

- **The four pathfinding files that did not survive phase 0** (`PathFinder.ts`,
  `.Air`, `.Station`, `spatial/SpatialQuery`) need rewriting against a province
  graph. They are in the history.
- **A second command type.** `claim_province` is the only one, and a command
  set of one hides whatever the second one will need.

Not started, and deliberately:

- **Deployment to a real host.** This machine has no `docs/deploy/HOST.local.md`
  and the DNS record is still an open question. `docs/deploy/README.md` has
  everything a host needs; phase 11 does it.
- **Accounts.** The nation comes from `?nation=` in the URL. A world on the
  internet needs more than that, and the account tables belong with the screens
  that use them.

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

**The browser leg is unverified as of the end of phase 1.** The world's socket
is proven three ways — `curl` gets `101 Switching Protocols` through the Vite
proxy on port 9000, a node client completes the handshake through the same
proxy, and `scripts/phase1-gate.mjs` plays a whole game over it. What has not
been seen is the map in a browser: in an automated Chrome the page's own
WebSocket to `/ws` fails immediately while Vite's HMR socket on the same origin
connects, which points at the automation rather than at the code, but points at
nothing conclusively. **Open `http://localhost:9000/?nation=<n>` by hand before
trusting the client half of phase 1.** The renderer itself is unchanged since
phase 0, where it did draw the map; what is new is the socket's `nation` field,
the ack handling and claim-by-click.

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
npm run inst                 # npm ci --ignore-scripts — never `npm install`
npm run typecheck            # tsc over everything, must be clean
npm run typecheck:strict     # tsc over shared/ + server/ with strict: true
npm run lint                 # oxlint + eslint, must be clean
npm run test                 # one vitest run; see baseline below
npm run test:db              # the Postgres tests; needs `docker compose up -d db`
npm run build-prod           # tsc + vite + asset hashing; the real integration test
npm run check:doc-links      # every relative link in every .md resolves
docker compose up -d         # Postgres + the world
npm run start:client         # http://localhost:9000/?nation=1
node scripts/phase1-gate.mjs # the phase-1 gate, end to end
```

The last three are the ones that matter. A green suite says the pieces
type-check and their units behave; only running them shows a map, and only the
gate shows a world that survives.

### Test baseline

**412 passed, 7 skipped, in one run — no tolerated failures.** `npm run test` is
a single `vitest run`. The seven skipped are the Postgres integration tests,
which run under `npm run test:db` against `docker compose up -d db`; a unit
suite that needs a container is a unit suite people stop running.

That is a change of kind, not just of number. The two environmental failures
this document used to tell you to ignore — the de-DE thousands separator and
the InventoryModal timeout — went into quarantine with their subjects. The
rule is now **every failure is yours**, not every third one. If you are
looking for two red tests because you read an older version of this file,
stop looking.

The count moved from 4012 because ~300 test files test code that no longer
exists and are in `tests/_legacy/`, excluded from the run. They were moved
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
