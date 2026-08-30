# 0001 — Break the `core`↔`client` cycle by moving terrain primitives to `shared/`

- **Status:** Accepted
- **Date:** 2026-08-30
- **Phase:** 0

## Context

The plan for this fork is "keep the renderer, delete the simulation". That turned
out not to be a possible operation as stated, because `src/core` and `src/client`
are not two layers with a seam between them — they are one strongly connected
import cycle:

```
src/core/configuration/Config.ts:2
    import { PlayerView } from "../../client/view";
```

`client/view/GameView.ts` imports back into `core/worker/WorkerClient`, which
reaches `GameRunner` and every Execution.

**Measurement (2026-08-30).** A throwaway TypeScript project whose only content
was `import type { FrameData }` from the renderer, compiled with
`tsc --listFiles`, pulled in **86 files, 54 of them from `src/core`**. The
renderer's own type graph reached the entire simulation.

The head of the chain was a single import:

```
render/types/Renderer.ts -> core/game/GameMap.ts -> core/game/Game.ts
    -> core/configuration/Config.ts -> client/view -> GameView -> worker -> Executions
```

`GameMap.ts` needed exactly two things from `Game.ts`: `Cell` and `TerrainType`.

## Decision

Move `MapPos`, `GameMapSize`, `Cell` and `TerrainType` into
`src/shared/map/Terrain.ts` and point `GameMap.ts` at that. `Game.ts` re-exports
all four, so its existing importers stay untouched.

Result, same measurement: **9 files, 1 from `src/core`** — and that one is
`GameMap.ts` itself, which moves to `shared/` later.

## Alternatives rejected

- **Define `TileRef` locally in the renderer.** It is only
  `type TileRef = number`, so this breaks the chain in one line. Rejected because
  it fixes the symptom at one call site while leaving the cycle intact for the
  server, which needs `GameMap` too and must never import client code to get it.
- **Move `GameMap.ts` to `shared/` immediately.** Correct destination, wrong
  moment: 84 files import it, 18 of them in `src/core/execution`, which will be
  deleted rather than rewritten. Doing it now means editing import paths in files
  that will not exist next week. Deferred until `execution/` is gone.
- **Build a parallel `src/world-client/` and leave `src/core` untouched.**
  Reaches a rendering client faster and keeps upstream merges possible. Rejected:
  this is a hard fork with no intention of merging upstream, the specification
  mandates a `shared/` package, and the cycle would still have to be broken — a
  world client importing `GameMap.ts` inherits exactly the same 54 files.

## Consequences

- `src/shared/` now exists and has its first inhabitant. Everything worth keeping
  from `core` moves there.
- The renderer can be type-checked without the simulation present, which is what
  makes the rest of phase 0 possible.
- `Game.ts` grew a re-export block. It is temporary scaffolding: when `Game.ts`
  is deleted, its importers move to `shared/map/Terrain` directly.
- Deleting `src/core` is now a mechanical operation rather than an
  archaeological one.
