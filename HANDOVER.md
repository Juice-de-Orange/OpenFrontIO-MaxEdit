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
client against upstream's match server. Nothing world-shaped exists yet.

Four commits so far:

| Commit     | What                                                           |
| ---------- | -------------------------------------------------------------- |
| `0f5db0ff` | Fork seeded with the spec; dead `gatekeeper` submodule dropped |
| `66ffc877` | **The `core`↔`client` import cycle broken**                    |
| `2c46fc4f` | Upstream's proprietary assets removed, own brand marks added   |
| `2ecb317b` | Documentation system, new README, hardened `.gitignore`        |

Working tree is clean. Nothing has been pushed — the remote is still at the
upstream fork point.

### Against the phase-0 step list

The plan's step order is in the plan file (see _Where the plan lives_ below).
Status:

- **Step 1** — `index.html` gutting: **not done**. The `gatekeeper` half is done.
- **Step 2** — `shared/util/`: **not done**.
- **Step 3** — break the cycle: **done**, except that `GameMap.ts` itself has
  not physically moved to `shared/map/` yet (deliberate — see below).
- **Steps 4–14** — not started.
- **Step 15** — licence hygiene: **done, pulled forward.** It could not wait:
  the repository is public, so shipping upstream's All-Rights-Reserved assets
  was actively redistributing them.

---

## What to do next

Finish severing the renderer from `src/core`. Nine modules remain. Cheapest
first, because each one that goes makes the next measurement clearer:

1. **`core/AssetUrls`** — 10 sites. 116 lines, zero imports. Move to
   `client/util/`. **`vite.config.ts` imports it too**, so fix that in the same
   edit or the toolchain dies.
2. **`core/game/Veterancy`** — 1 site. 23 lines, zero imports.
3. **`core/PatternDecoder`** — 1 site, in `preview/PreviewTerritoryPass.ts`.
4. **`core/game/Game`** — 2 sites, `UnitType` and `GameMapType`. Extract the
   enums exactly the way `Terrain.ts` was extracted.
5. **`core/game/TerrainMapLoader`** — 2 sites, type-only (`MapLayer`). Moves to
   `shared/map/` with the rest of the map code.
6. **`core/game/GameUpdates`** — 2 sites, only `RailroadCache.ts`. Quarantine
   that file; `railroadDirty` stays `false` and nothing notices.
7. **`core/configuration/Config`** — 10 sites, and the one that matters. Replace
   with a narrow `RenderConfig` interface: only **7 methods** are ever used —
   `msPerTick`, `unitInfo`, `warshipVeterancyHealthBonus`,
   `deletionMarkDuration`, `SAMCooldown`, `SiloCooldown`,
   `allianceExtensionPromptOffset`. Upstream's
   `render/preview/CosmeticPreviewRenderer.ts` already builds a mock Config —
   copy that shape.
8. **`core/CosmeticSchemas`** — 3 sites, 575 lines, the expensive one. Two uses
   are the debug effect editor, which can go entirely; check
   `gl/utils/EffectPalette.ts` before deleting anything.
9. **`core/game/GameMap`** — 1 site. Last.

**Why `GameMap.ts` has not moved:** 84 files import it, 18 of them under
`src/core/execution` — code that will be deleted, not rewritten. Moving it now
means editing import paths in files that will not exist next week. Move it once
`execution/` is gone.

After that: quarantine (`git mv` the HUD and components into
`src/client/_legacy/`, exclude from tsconfig and lint — do **not** delete;
`BuildMenu.ts` is the skeleton for phase 3, `PlayerPanel.ts` for phase 7), then
delete `src/core` and `src/server`, then the protocol and the stub server.

---

## Traps already paid for

Things that cost time to find. Do not rediscover them.

**`vite.config.ts` imports from `src/`.** It pulls `src/core/AssetUrls` and
`src/server/PublicAssetManifest` at _config evaluation time_ — before a build
**and before the tests**. Delete or move either without fixing the config first
and the whole toolchain dies with an error pointing at the wrong file.

**The renderer contract is bigger than `FrameData`.** The constructor also
requires a `RendererConfig` (map dimensions, unit types, **and the player
list**) and a palette array. Territory colour comes from the palette indexed by
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

`4010 / 4012` pass. The two failures are **not** regressions:

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

**54** before the cut, **1** now. It should only ever go down. This deserves to
become a permanent test (plan step 14).

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
