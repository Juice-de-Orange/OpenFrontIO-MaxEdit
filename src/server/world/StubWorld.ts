/**
 * A world that ticks, with no simulation in it yet.
 *
 * It owns exactly what phase 0 needs the server to own: the map, the province
 * partition derived from it, and who holds each province. One province changes
 * hands per tick, chosen deterministically at a border.
 *
 * Phases 1 and up replace the inside of `step()` with the real system order
 * (economy, construction, production, …) and add persistence around it. What
 * does not change is the shape: the server holds the authoritative state and
 * emits what changed.
 */

import fs from "fs/promises";
import path from "path";
import {
  computeProvinceGrid,
  terrainHashFnv1a,
  type ProvinceGrid,
} from "src/shared/map/ProvinceGrid";
import type { MapDescriptor, NationStatic } from "src/shared/protocol/Wire";

/** Grid cell size in tiles. Must match what the client uses. */
const PROVINCE_CELL = 64;

interface ManifestNation {
  name: string;
  coordinates: [number, number];
}

interface MapManifest {
  map: { width: number; height: number };
  map4x: { width: number; height: number };
  nations?: ManifestNation[];
}

export class StubWorld {
  private tick = 0;
  private readonly owners: number[];
  private readonly neighbours: number[][];

  private constructor(
    readonly descriptor: MapDescriptor,
    readonly nations: NationStatic[],
    private readonly grid: ProvinceGrid,
    seeds: { x: number; y: number }[],
  ) {
    this.owners = assignNearest(grid, seeds);
    this.neighbours = buildAdjacency(grid, descriptor.width);
  }

  static async load(mapId: string, resourcesDir: string): Promise<StubWorld> {
    const dir = path.join(resourcesDir, "maps", mapId);
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf-8"),
    ) as MapManifest;
    const terrain = new Uint8Array(
      await fs.readFile(path.join(dir, "map4x.bin")),
    );

    const { width, height } = manifest.map4x;
    if (terrain.length !== width * height) {
      throw new Error(
        `Map ${mapId}: manifest says ${width}x${height}, map4x.bin has ${terrain.length} bytes`,
      );
    }

    const grid = computeProvinceGrid(terrain, width, height, PROVINCE_CELL);

    // Manifest coordinates are full-map; the client scales them the same way.
    const scale = manifest.map.width / width;
    const raw = manifest.nations ?? [];
    const seeds = raw.map((n) => ({
      x: Math.min(width - 1, Math.round(n.coordinates[0] / scale)),
      y: Math.min(height - 1, Math.round(n.coordinates[1] / scale)),
    }));
    const nations: NationStatic[] = raw.map((n, i) => ({
      smallID: i + 1,
      name: n.name,
    }));

    const descriptor: MapDescriptor = {
      id: mapId,
      width,
      height,
      provinceCount: grid.count,
      terrainHash: terrainHashFnv1a(terrain),
    };

    return new StubWorld(descriptor, nations, grid, seeds);
  }

  currentTick(): number {
    return this.tick;
  }

  ownerSnapshot(): number[] {
    return [...this.owners];
  }

  /**
   * Advance one tick and return what changed.
   *
   * Deterministic sweep rather than a random pick: the tick has to be
   * reproducible from the log, which is what phase 1's restore depends on.
   * No Math.random() anywhere near world state — CLAUDE.md §9.
   */
  step(): [number, number][] {
    this.tick++;
    if (this.grid.count === 0) return [];

    const changes: [number, number][] = [];
    const start = (this.tick * 7919) % this.grid.count;
    for (let i = 0; i < this.grid.count; i++) {
      const province = (start + i) % this.grid.count;
      const mine = this.owners[province];
      const taker = this.neighbours[province].find(
        (n) => this.owners[n] !== mine && this.owners[n] !== 0,
      );
      if (taker !== undefined) {
        this.owners[province] = this.owners[taker];
        changes.push([province, this.owners[province]]);
        break;
      }
    }
    return changes;
  }
}

/** Nearest seed by squared distance; ties go to the lower index. */
function assignNearest(
  grid: ProvinceGrid,
  seeds: { x: number; y: number }[],
): number[] {
  const owners = new Array<number>(grid.count).fill(0);
  if (seeds.length === 0) return owners;

  for (let p = 0; p < grid.count; p++) {
    const c = grid.centres[p];
    let best = 0;
    let bestDist = Infinity;
    for (let s = 0; s < seeds.length; s++) {
      const dx = c.x - seeds[s].x;
      const dy = c.y - seeds[s].y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    owners[p] = best + 1;
  }
  return owners;
}

/** Provinces sharing a grid edge, from the tile labels. */
function buildAdjacency(grid: ProvinceGrid, width: number): number[][] {
  const sets = Array.from({ length: grid.count }, () => new Set<number>());
  const { provinceOfTile } = grid;
  const height = provinceOfTile.length / width;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = provinceOfTile[y * width + x];
      if (a < 0) continue;
      if (x + 1 < width) {
        const b = provinceOfTile[y * width + x + 1];
        if (b >= 0 && b !== a) {
          sets[a].add(b);
          sets[b].add(a);
        }
      }
      if (y + 1 < height) {
        const b = provinceOfTile[(y + 1) * width + x];
        if (b >= 0 && b !== a) {
          sets[a].add(b);
          sets[b].add(a);
        }
      }
    }
  }
  // Sorted arrays rather than Sets: Set iteration order is insertion order,
  // and anything order-dependent has to be reproducible.
  return sets.map((s) => [...s].sort((p, q) => p - q));
}
