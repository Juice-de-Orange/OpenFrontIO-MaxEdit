# 0004 — The renderer owns its own vocabulary

- **Status:** Accepted
- **Date:** 2026-08-30
- **Phase:** 0

## Context

Decision [0001](0001-break-core-client-import-cycle.md) cut the `core`↔`client`
cycle at its head. What remained were nine modules the renderer still imported
from `src/core/` — 31 import statements across 24 files. Cutting them raised
three questions that the obvious answers get wrong.

**Measurement (2026-08-30).** The probe from `HANDOVER.md`, a throwaway compile
of a file whose only content is `import type { FrameData }`, counted 54
`src/core` files before 0001 and 1 after. Running the same probe from
`render/gl/Renderer.ts` instead — the renderer's actual entry point, not just
its type contract — reported **56**, and stayed at 56 after every one of the
nine couplings was resolved.

## Decision

**Type imports count.** The 56 came from `render/gl/Renderer.ts` importing
`translateText` from `client/Utils.ts`, which imports `core/game/Game`; and
from `preview/loadPreviewMap.ts` reaching `core/game/FetchGameMapLoader`
through `client/TerrainMapFileLoader`. Neither is a `src/core` import. The rule
is therefore stated over the module graph, not over the import list, and the
architecture test asserts both: no `src/core` edge, and no edge out of
`render/` except to named, verified-clean modules.

Even after splitting `Utils`, the first version of `i18n/Translate.ts` still
measured 56, because it imported `LangSelector` for one type annotation and
`LangSelector` reaches `Utils`. **A type-only import is a real edge in the type
graph.** It is erased from the bundle, not from `tsc`.

**Structural types instead of named ones, where only a field is read.** Three
couplings dissolved this way rather than by moving code: `translateText` types
its lang-selector as the four fields it reads, `PatternDecoder`'s constructor
takes `{ patternData: string }` instead of `PlayerPattern` (which pulled in
`Schemas.ts`, 1156 lines, and closed a three-module cycle), and
`RenderRules.unitInfo` returns `{ maxHealth?, constructionDuration? }` instead
of `UnitInfo` (whose `cost` field is `(game: Game, player: Player) => Gold`).
In each case the real object stays assignable and no caller changes.

**`RenderRules` lives in `render/types/`, not in `shared/`.** The world server
will never implement it — it draws nothing. It supplies the numbers behind it,
which will live in `shared/config/`, but the interface is the renderer's
statement of what it needs, so it belongs to the renderer. `shared/` is for
things both sides need the same answer to, not for everything that happens to
be clean.

**`unitInfo` deliberately keeps the shape it has on `Config`.** Flattening it
to `maxHealth(type)` / `constructionDuration(type)` reads better and would
break the one property that makes this cheap: upstream's `Config` class
satisfies `RenderRules` structurally, so `ClientGameRunner` passes its real
config object straight through. No adapter, no cast, no change to `core/`, and
nothing to delete later.

**`TileRef` becomes `number` in the renderer.** 0001 explicitly rejected this,
on the grounds that it "fixes the symptom at one call site while leaving the
cycle intact for the server". The cycle is gone, so that reasoning has expired.
What remains is a different question — should the renderer name tile
references at all — and it already answers no: `pos`, `lastPos`, `targetTile`,
`spawnTile` and `upgradeTargetTile` are all plain numbers in the same file.

## Alternatives rejected

- **Re-export shims in `core/`, as `Terrain.ts` did.** That precedent holds at
  ~12 importers in files that stay. Here every symbol had ≤ 7 importers or its
  importers were in the delete zone — and for `AssetUrls` the shim would have
  had to re-export `assetUrl`, i.e. import `core/ -> client/util/`, exactly the
  direction 0001 removed.
- **Moving everything clean into `shared/`.** `shared/` would have collected
  the palette attribute types, the effect editor's schemas and `RenderRules`,
  none of which any world system will ever read. The criterion is "both sides
  need the same answer", not "has no imports". `EffectPalette`'s attribute
  union is written out locally instead, and the compiler catches drift where
  `WebGLFrameBuilder` hands zod-typed values to `packEffectEntry`.
- **Keeping the cosmetic effect editor and moving its schemas.** It authored
  catalog JSON for upstream's cosmetics store, which this fork does not have.
  Deleting it removed 369 lines and the renderer's runtime dependency on
  `CosmeticSchemas` in one step.
- **Quarantining `frame/RailroadCache.ts` whole**, as the handover suggested,
  on the grounds that `railroadDirty` would stay false and nothing would
  notice. `Upload.ts:86` gates the GPU upload on that flag, so the rails would
  have left the picture — a behaviour change described as a no-op.

## Consequences

- The renderer type-checks with no part of the simulation present. All four
  probes (`FrameData`, `gl/Renderer`, `gl/MapRenderer`,
  `preview/CosmeticPreviewRenderer`) report zero `src/core` files.
- Two mechanisms keep it that way: `tests/architecture/RenderBoundary.test.ts`
  over the whole tree, and `no-restricted-imports` zones in `eslint.config.js`
  for `render/` and `shared/`. Both were verified to fail on a deliberately
  introduced violation, in both directions.
- `src/shared/` has six inhabitants now: `map/Terrain.ts`, `map/Maps.gen.ts`,
  `util/AssetPath.ts`, `util/Format.ts`, `util/PatternDecoder.ts`,
  `util/Veterancy.ts`.

  **Corrected 2026-08-30, same day.** `util/Format.ts` first went to
  `render/util/Format.ts`, on the argument that the UI's number vocabulary
  (invariant 9) belongs to the renderer. That was wrong, and code review
  caught it: `client/Utils.ts` re-exports those formatters, and four
  simulation files take them from there to build their message text — so the
  edge ran `core -> client/render`, the very one this record is about, only
  reversed. Neither guard saw it, because both watch edges _leaving_ render/.
  The simulation and the renderer formatting the same numbers is the shared/
  criterion stated literally, so `shared/util/` is where it belongs. The
  lesson generalises: "which package does this concept belong to" is the wrong
  question; "who needs the same answer" is the right one.

- Deleting `src/core` and `src/server` is now blocked only by the client code
  outside the renderer, not by the renderer itself.
- `RenderRules` will need an implementation when `Config` goes. It is seven
  lines of object literal, and `preview/CosmeticPreviewRenderer.ts` already
  contains a complete one to copy.
