# Quarantine — upstream's client

**Nothing here compiles.** These files are a reference corpus, not code. They
are excluded from `tsconfig`, from both linters, and from the test run, and
their imports point at paths that have moved or at `src/core`, which is gone.

The last commit in which this tree built and ran is **`93ddaa30`**. To read a
file as it worked:

```bash
git show 93ddaa30:src/client/hud/layers/BuildMenu.ts
```

## Why keep it

Upstream's HUD is the closest thing to a specification for screens this fork
has not written yet. Deleting it would mean re-deriving, from scratch, layouts
and interactions that already work. Deleting it _later_ costs nothing.

## The revival list

Files that are expected back, with the phase that needs them:

| File                                                         | Phase | For                                               |
| ------------------------------------------------------------ | ----- | ------------------------------------------------- |
| `hud/layers/BuildMenu.ts`                                    | 3     | the construction queue                            |
| `hud/layers/PlayerPanel.ts`                                  | 7     | diplomacy and agreements                          |
| `components/StatsTable.ts`, `hud/layers/lib/StatsColumns.ts` | —     | number presentation, design invariant 9           |
| `theme/ColorAllocator.ts`, `theme/ThemeProvider.ts`          | 2     | LAB-contrast colours between neighbouring nations |
| `InputHandler.ts`, `TransformHandler.ts`                     | 2     | input and picking, once clicks select provinces   |
| `hud/GameRenderer.ts`                                        | 3     | the HUD composition root                          |

Nothing on this list is copied back unchanged: each returns rewritten against
whatever replaced `GameView`. The value is the layout and the edge cases, not
the code.

## Expiry

**End of phase 7.** Whatever is still here then gets deleted — by that point
every screen on the list above has either been rebuilt or been decided against,
and a reference nobody has opened in seven phases is not a reference.

## What is _not_ here

- `src/core` and `src/server` — deleted outright in phase 0. Their salvageable
  parts moved to `src/shared/`; the rest is in the history.
- The cosmetic effect editor — deleted, not quarantined. This fork has no
  cosmetics store, so it has nothing to author.
