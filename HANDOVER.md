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

**Phase 0 of 11 — fork triage. Complete.** A world server ticks every five
seconds and pushes province ownership over a versioned WebSocket protocol; the
inherited renderer draws it. `src/core` and `src/server` are gone, the rest of
the upstream client is quarantined, and the simulation is not in the shipped
bundle.

**Start it with two commands:**

```bash
npm run start:server # the world on ws://localhost:3000/ws
npm run start:client # http://localhost:9000
```

The numbers that say it best, from `npm run build-prod`:

| Artefact                                       | before     | now         |
| ---------------------------------------------- | ---------- | ----------- |
| `index.html`                                   | 28.02 kB   | **0.96 kB** |
| `index-*.js`                                   | 2307.84 kB | **436 kB**  |
| `Worker.worker-*.js` (the lockstep simulation) | 625.16 kB  | **gone**    |
| `debug-*.js`                                   | 50.41 kB   | **gone**    |

| Commit     | What                                                              |
| ---------- | ----------------------------------------------------------------- |
| `0f5db0ff` | Fork seeded with the spec; dead `gatekeeper` submodule dropped    |
| `66ffc877` | **The `core`↔`client` import cycle broken**                       |
| `2c46fc4f` | Upstream's proprietary assets removed, own brand marks added      |
| `2ecb317b` | Documentation system, new README, hardened `.gitignore`           |
| `49dc9342` | Handover, inherited docs separated, link checker                  |
| `ce7e9b71` | Upstream's trackers and remote script loader out of `index.html`  |
| `32f56c2f` | Import ratchet for the renderer boundary                          |
| `e2d5207d` | `TileRef` → `number`; probe from `FrameData` hits 0               |
| `eccefb77` | `Veterancy` → `shared/util/`                                      |
| `ad476545` | `PatternDecoder` → `shared/util/`, schema cycle broken            |
| `4ae6b103` | `Maps.gen` → `shared/map/`; `MapLayer` duplicate collapsed        |
| `35100e3b` | Cosmetic effect editor deleted, palette types inlined             |
| `cfe93756` | `PublicAssetManifest` → `src/build/`                              |
| `328cf82b` | `AssetUrls` split into `shared/util/AssetPath` + `client/util/`   |
| `c8ed6cbf` | `Config` → `RenderRules`; `UnitType` resolved with it             |
| `f4da0196` | Rail geometry split from the `GameUpdates` accumulator            |
| `65c654d1` | `Utils` split; probe from `gl/Renderer.ts` 56 → 0                 |
| `2c123ff8` | Preview map loaded without the core map loader                    |
| `44d1a6c5` | Ratchet becomes a prohibition; lint zones; decision 0004          |
| `0dcb4dda` | Code-review fixes, one of which undid part of the work            |
| `f8e72532` | Province grid and terrain hash in `shared/map/`                   |
| `4e3231c4` | Map loading, palette and frame adapter                            |
| `baf19d02` | **`index.html` boots the world client — the gate**                |
| `459f5437` | **Quarantine, `src/core` and `src/server` deleted, world server** |
| `9db3ae42` | Provinces grown from national borders, not a grid                 |

Working tree is clean, and everything is pushed.

### Against the phase-0 step list

Every step is done. What each one turned into:

| Step                     | Outcome                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `index.html`           | Rewritten around the world client. The old page is kept as `docs/upstream/index.upstream.html` for the custom elements its body declares — the markup phase 3 and 7 screens have to reproduce.                                            |
| 2 `shared/util/`         | `AssetPath`, number formatting, `PatternDecoder`, `Veterancy`, `EventBus`, `PseudoRandom`, `DebugSpan`.                                                                                                                                   |
| 3 the import cycle       | Cut. `GameMap.ts` now lives in `shared/map/`.                                                                                                                                                                                             |
| 4 `shared/pathfinding/`  | 19 of 23 files rescued. The four importing `game/Game` (PathFinder.ts, .Air, .Station, spatial/SpatialQuery) were not — they are built around upstream's unit world and need rewriting against a province graph. They are in the history. |
| 5 the nine couplings     | All resolved, plus two transitive leaks the original count missed.                                                                                                                                                                        |
| 6 `RenderConfig`         | Shipped as `RenderRules`, seven methods.                                                                                                                                                                                                  |
| 7 quarantine             | 259 client files, 336 test files, in `src/client/_legacy/` and `tests/_legacy/`.                                                                                                                                                          |
| 8 delete core and server | Done: 135 + 48 files.                                                                                                                                                                                                                     |
| 9 `shared/protocol/`     | `Wire.ts` — JSON, zod-validated, version in the handshake.                                                                                                                                                                                |
| 10 stub server           | `src/server/`: one process, one world, five-second tick.                                                                                                                                                                                  |
| 11 store and socket      | `client/world/`: socket, tile index, frame adapter.                                                                                                                                                                                       |
| 12 bootstrap             | `WorldClient.ts`.                                                                                                                                                                                                                         |
| 13 tsconfig split        | Not done — a single tsconfig still covers everything. `shared/` is not yet on `strict`, and that is the one piece of step 13 worth doing early.                                                                                           |
| 14 architecture test     | Two of them, plus lint zones.                                                                                                                                                                                                             |
| 15 licence hygiene       | Done, pulled forward.                                                                                                                                                                                                                     |

**Reached ahead into phase 2:** the province partition. The throwaway 64x64
grid was replaced by one grown from the national capitals — see below.

---

## What to do next

Phase 0 is closed. Phase 1 is world persistence, and the plan file has it in
detail. In short:

1. **Tick loop with a real deadline.** `src/server/Main.ts` uses
   `setInterval`, which accumulates drift and fires bursts when behind.
   Replace with a deadline computed from a fixed epoch, and **await the tick**
   — two overlapping ticks end determinism.
2. **Postgres**: command log, snapshot every 60 ticks, restore on startup,
   advisory lock on `world_id`.
3. **Deploy**, which the plan pulls forward from phase 11.

Two things block deployment and need a decision:

- The **DNS record** for the world's domain — by hand or via API.
- The deployment host has a **pending reboot**. A persistent world should not
  be rolled out the week before one without agreeing how it drains first.

Worth doing early in phase 1, while the code is small:

- **`strict` for `shared/`** (step 13). CLAUDE.md §9 requires it and no `any`;
  the longer `shared/` grows without it, the more it costs.
- **A `Command` type** in the protocol. Deliberately absent in phase 0 —
  §7 wants commands validated against world state and there was none — but the
  server already disconnects on any message after `hello`, so the shape is
  waiting.

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

**`systemctl reload nginx` lies** (relevant from phase 1). Covered in
`docs/deploy/README.md`.

**A green test can be worse than a red one.** When background music was
removed, one test's assertion body stopped running — it would have passed while
checking nothing. It is `it.skip` with a comment, not "fixed". Watch for this
shape whenever you remove data that a test iterates over.

---

## How to verify anything

```bash
npm run inst            # npm ci --ignore-scripts — never `npm install`
npx tsc --noEmit        # must be clean
npm run lint            # oxlint + eslint, must be clean
npm run test            # one vitest run; see baseline below
npm run build-prod      # tsc + vite + asset hashing; the real integration test
npm run check:doc-links # every relative link in every .md resolves
npm run start:server    # the world, ws://localhost:3000/ws
npm run start:client    # http://localhost:9000
```

The last two are the ones that matter. A green suite says the pieces type-check
and their units behave; only running the pair shows a map.

### Test baseline

**385/385 in one run, no tolerated failures.** `npm run test` is a single
`vitest run` now.

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

The full implementation plan — phase by phase, with the measured numbers behind
each decision — is **outside this repository**, at:

```
C:\Users\maxob\.claude\plans\schau-dir-die-md-proud-unicorn.md
```

It is not committed because it is a working document for one machine, and parts
of it discuss a specific deployment host. `CLAUDE.md` is the authoritative
public specification; the plan is how we get there.

---

## Open questions

**Needs a decision before phase 1 deployment:**

- DNS record for the world's domain — who creates it, and by hand or via API.
- The deployment host has a pending reboot. A persistent world should not be
  rolled out the week before one without agreeing how it drains first.

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
