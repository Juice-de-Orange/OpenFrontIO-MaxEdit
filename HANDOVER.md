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

**Phase 0 of 11 — fork triage.** The tree still boots upstream's lockstep
client against upstream's match server. Nothing world-shaped exists yet — but
**the renderer no longer touches the simulation**, which was the thing standing
between here and everything else.

| Commit     | What                                                             |
| ---------- | ---------------------------------------------------------------- |
| `0f5db0ff` | Fork seeded with the spec; dead `gatekeeper` submodule dropped   |
| `66ffc877` | **The `core`↔`client` import cycle broken**                      |
| `2c46fc4f` | Upstream's proprietary assets removed, own brand marks added     |
| `2ecb317b` | Documentation system, new README, hardened `.gitignore`          |
| `49dc9342` | Handover, inherited docs separated, link checker                 |
| `ce7e9b71` | Upstream's trackers and remote script loader out of `index.html` |
| `32f56c2f` | Import ratchet for the renderer boundary                         |
| `e2d5207d` | `TileRef` → `number`; probe from `FrameData` hits 0              |
| `eccefb77` | `Veterancy` → `shared/util/`                                     |
| `ad476545` | `PatternDecoder` → `shared/util/`, schema cycle broken           |
| `4ae6b103` | `Maps.gen` → `shared/map/`; `MapLayer` duplicate collapsed       |
| `35100e3b` | Cosmetic effect editor deleted, palette types inlined            |
| `cfe93756` | `PublicAssetManifest` → `src/build/`                             |
| `328cf82b` | `AssetUrls` split into `shared/util/AssetPath` + `client/util/`  |
| `c8ed6cbf` | `Config` → `RenderRules`; `UnitType` resolved with it            |
| `f4da0196` | Rail geometry split from the `GameUpdates` accumulator           |
| `65c654d1` | `Utils` split; probe from `gl/Renderer.ts` 56 → 0                |
| `2c123ff8` | Preview map loaded without the core map loader                   |

Working tree is clean. Nothing has been pushed — the remote is still at the
upstream fork point.

### Against the phase-0 step list

The plan's step order is in the plan file (see _Where the plan lives_ below).
Status:

- **Step 1** — `index.html`: **head done.** Every foreign account id and the
  remote script loader are gone. The body still declares upstream's custom
  elements; it gets rewritten with the new bootstrap rather than twice.
- **Step 2** — `shared/util/`: **done** (`AssetPath`, `PatternDecoder`,
  `Veterancy`). `EventBus` and `PseudoRandom` have not moved yet.
- **Step 3** — break the cycle: **done**, except that `GameMap.ts` itself has
  not physically moved to `shared/map/` yet (deliberate — see below).
- **Step 5** — the nine couplings: **done, all of them**, plus two transitive
  leaks the original count missed.
- **Step 6** — `RenderConfig`: **done**, as `RenderRules`.
- **Step 14** — architecture test: **done**, plus lint zones.
- **Steps 7–13** — quarantine, deletion, protocol, stub server: not started.
- **Step 15** — licence hygiene: **done, pulled forward.** It could not wait:
  the repository is public, so shipping upstream's All-Rights-Reserved assets
  was actively redistributing them.

---

## What to do next

The renderer is done. What stands between here and the phase-0 gate is the
client _around_ it, in this order:

1. **A new bootstrap.** `src/client/Main.ts` (1322 lines) and
   `ClientGameRunner.ts` (1555) are the roots that keep every HUD file
   reachable. Nothing can be quarantined until they are replaced, because
   `tsconfig`'s `exclude` does not cut an imported file out of the program —
   it only drops it from the root set.
2. **Quarantine** — `git mv` the HUD, components, view and controllers into
   `src/client/_legacy/`, then exclude from tsconfig **and both linters in the
   same commit** (eslint uses `projectService`, oxlint has `typeAware: true`;
   a file excluded from tsconfig but linted makes both abort).
3. **Delete `src/core` and `src/server`.**
4. **`shared/protocol/` and the stub server.**

Decisions already taken for that work, so they do not have to be revisited:

- Quarantine stays **under `src/`** (`src/client/_legacy/`, `tests/_legacy/`).
  `tests/TranslationSystem.test.ts:524` scans the filesystem under `src/` and
  demands no unused translation keys; a `_legacy/` at repo level would orphan
  hundreds of them.
- Tests for deleted code are **quarantined, not deleted** — same rule as the
  HUD. `AttackLogicGolden`, `tests/pathfinding` and `MapConsistency` are
  effectively the world server's specification.
- The cosmetic effect editor is **gone**, not quarantined. This fork has no
  cosmetics store.

**Why `GameMap.ts` has not moved:** 104 files import it, 25 of them under
`src/core/execution` — code that will be deleted, not rewritten. Moving it now
means editing import paths in files that will not exist next week. Move it once
`execution/` is gone. The renderer no longer needs it either way.

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
npx vitest run          # see baseline below
npm run build-prod      # tsc + vite + asset hashing; the real integration test
npm run check:doc-links # every relative link in every .md resolves
npm run dev             # http://localhost:9000
```

### Test baseline — do not chase these two

`4005 / 4009` pass in the main run (339 files), plus `578 / 578` in the
separate `tests/server` run (56 files). **These are two runs**: `npm run test`
is `vitest run && vitest run tests/server`, and the server tests do not appear
in the 4009.

The main-run total moved from 4012 during phase 0. What changed: the effect
editor's tests were deleted with it, `PublicAssetManifest.test.ts` moved from
`tests/server` into the main run along with its subject, and two architecture
tests were added. The passing figure moves with the `InventoryModal` flake
below; the total is what to compare against.

The two failures are **not** regressions:

1. `tests/client/clan/ClanDonateDialog.test.ts` — expects the en-US thousands
   separator (`1,000`); a `de-DE` machine renders `1.000`. Environmental.
2. `tests/client/InventoryModal.test.ts` — times out under parallel load.
   Run the file alone and all 27 tests pass. Sometimes two of its tests fail
   instead of one; that is the same flake, not a new fault.

Plus one deliberate `it.skip` in `SoundManager.test.ts` (see above).

**Any third failing file is yours.** Check it.

### Measuring the import boundary

The number that made phase 0 tractable. Reproduce it like this:

```bash
mkdir -p .cycle-probe
printf 'import type { FrameData } from "../src/client/render/types/FrameData";\nexport type Probe = FrameData;\n' > .cycle-probe/probe.ts
printf '{ "extends": "../tsconfig.json", "compilerOptions": { "noEmit": true, "types": [] }, "include": ["probe.ts"] }\n' > .cycle-probe/tsconfig.json
npx tsc -p .cycle-probe/tsconfig.json --listFiles --noEmit \
  | grep -v node_modules | sed "s|.*OpenFrontIO-MaxEdit/||" \
  | grep -c '^src/core/'
rm -rf .cycle-probe
```

**54** before the cut, **0** now.

That probe is the narrowest one available — it covers the type graph reachable
from `FrameData` alone. Run it from `render/gl/Renderer.ts` as well, which is
the renderer's real entry point; it read **56** while the `FrameData` probe
read 0. Both are 0 now, as are the probes from `gl/MapRenderer.ts` and
`preview/CosmeticPreviewRenderer.ts`.

It is a permanent test now: `tests/architecture/RenderBoundary.test.ts`, plus
`no-restricted-imports` zones for `render/` and `shared/` in
`eslint.config.js`. Both were verified by introducing a violation on purpose.

---

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
