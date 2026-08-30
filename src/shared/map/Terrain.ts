/**
 * Terrain primitives — the map vocabulary shared by client and server.
 *
 * These four declarations used to live in `src/core/game/Game.ts`, next to the
 * whole lockstep simulation. That was the head of an import cycle: `GameMap.ts`
 * needed nothing from `Game.ts` but `Cell` and `TerrainType`, yet importing
 * them pulled in `Game.ts` -> `configuration/Config.ts` -> `client/view` ->
 * `GameView` -> the core worker -> every Execution. Measured: a lone
 * `import type { FrameData }` in the renderer dragged 54 simulation files into
 * the type graph.
 *
 * Nothing here depends on anything else, which is precisely why it belongs in
 * `shared/`: the world server needs the same vocabulary to reason about
 * provinces, and it must never import client or simulation code to get it.
 *
 * `Game.ts` re-exports these so its ~12 existing importers keep working
 * unchanged.
 */

/** A position on the map, in tile coordinates. */
export interface MapPos {
  x: number;
  y: number;
}

/** Which resolution of a map's binary a world runs on. */
export enum GameMapSize {
  Compact = "Compact",
  Normal = "Normal",
}

/**
 * A tile coordinate pair with a cached string form.
 *
 * The cached `strRepr` is not decoration: cells are used as map keys on hot
 * paths, and rebuilding the template literal per lookup showed up in profiles.
 */
export class Cell {
  public index: number;

  private strRepr: string;

  constructor(
    public readonly x: number,
    public readonly y: number,
  ) {
    this.strRepr = `Cell[${this.x},${this.y}]`;
  }

  pos(): MapPos {
    return {
      x: this.x,
      y: this.y,
    };
  }

  toString(): string {
    return this.strRepr;
  }
}

export enum TerrainType {
  Plains,
  Highland,
  Mountain,
  Ocean,
  Impassable,
}
