/**
 * A world with no server, for bringing the renderer up.
 *
 * **Throwaway, and it has to stay easy to delete.** Its whole job is to prove
 * that the renderer draws from province ownership before a socket is involved,
 * so that a black canvas later has exactly one possible cause. Once
 * WorldSocket lands, this file goes, and a guard test asserts it is gone.
 *
 * It assigns each province to the nearest nation seed and then flips a border
 * province every tick — the same two operations the real server will perform,
 * so the client path exercised here is the path that stays.
 */

import type { ProvinceGrid } from "src/shared/map/ProvinceGrid";
import type { MapNation } from "./MapAssets";

export interface WorldSnapshot {
  tick: number;
  /** Owner per province: 0 unowned, else the nation's 1-based slot. */
  owners: number[];
}

export class StaticWorldSource {
  private readonly owners: number[];
  private readonly neighbours: number[][];
  private tick = 0;

  constructor(
    private readonly grid: ProvinceGrid,
    nations: MapNation[],
    mapWidth: number,
  ) {
    this.owners = assignNearest(grid, nations);
    this.neighbours = buildAdjacency(grid, mapWidth);
  }

  fullState(): WorldSnapshot {
    return { tick: this.tick, owners: [...this.owners] };
  }

  /**
   * Advance one tick and return what changed.
   *
   * Picks a province adjacent to a different owner and flips it, so the change
   * is always visible at a border rather than somewhere in an interior nobody
   * is looking at.
   */
  step(): { tick: number; changes: [number, number][] } {
    this.tick++;
    const changes: [number, number][] = [];

    // Deterministic sweep rather than random: reproducible, and no
    // Math.random() anywhere near world state.
    const start = (this.tick * 7919) % Math.max(1, this.grid.count);
    for (let i = 0; i < this.grid.count; i++) {
      const province = (start + i) % this.grid.count;
      const mine = this.owners[province];
      const takeable = this.neighbours[province].find(
        (n) => this.owners[n] !== mine && this.owners[n] !== 0,
      );
      if (takeable !== undefined) {
        this.owners[province] = this.owners[takeable];
        changes.push([province, this.owners[province]]);
        break;
      }
    }
    return { tick: this.tick, changes };
  }
}

/** Nearest seed by squared distance; ties go to the lower nation index. */
function assignNearest(grid: ProvinceGrid, nations: MapNation[]): number[] {
  const owners = new Array<number>(grid.count).fill(0);
  if (nations.length === 0) return owners;

  for (let p = 0; p < grid.count; p++) {
    const c = grid.centres[p];
    let best = 0;
    let bestDist = Infinity;
    for (let n = 0; n < nations.length; n++) {
      const [nx, ny] = nations[n].coordinates;
      const dx = c.x - nx;
      const dy = c.y - ny;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    owners[p] = best + 1; // slot 0 is unowned
  }
  return owners;
}

/** Provinces sharing a grid edge, derived from the tile labels. */
function buildAdjacency(grid: ProvinceGrid, mapWidth: number): number[][] {
  const sets = Array.from({ length: grid.count }, () => new Set<number>());
  const { provinceOfTile } = grid;
  const height = provinceOfTile.length / mapWidth;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < mapWidth; x++) {
      const a = provinceOfTile[y * mapWidth + x];
      if (a < 0) continue;
      if (x + 1 < mapWidth) {
        const b = provinceOfTile[y * mapWidth + x + 1];
        if (b >= 0 && b !== a) {
          sets[a].add(b);
          sets[b].add(a);
        }
      }
      if (y + 1 < height) {
        const b = provinceOfTile[(y + 1) * mapWidth + x];
        if (b >= 0 && b !== a) {
          sets[a].add(b);
          sets[b].add(a);
        }
      }
    }
  }
  // Sorted arrays, not Sets: iteration order of a Set is insertion order, and
  // anything order-dependent has to be reproducible.
  return sets.map((s) => [...s].sort((p, q) => p - q));
}
