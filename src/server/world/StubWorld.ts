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
import { terrainHashFnv1a } from "src/shared/map/TerrainHash";
import {
  computeProvincePartition,
  type ProvincePartition,
} from "src/shared/map/ProvincePartition";
import type { MapDescriptor, NationStatic } from "src/shared/protocol/Wire";

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
    private readonly partition: ProvincePartition,
  ) {
    // Ownership comes straight from the partition: a province belongs to the
    // nation whose territory it was cut out of, so no province starts split
    // across a border. Slot 0 stays "unowned".
    this.owners = Array.from(partition.nationOfProvince, (n) => n + 1);
    this.neighbours = partition.neighbours;
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

    // Manifest coordinates are full-map; the client scales them identically,
    // which it has to — the partition is derived on both sides and never sent.
    const scale = manifest.map.width / width;
    const raw = manifest.nations ?? [];
    const seeds = raw.map((n) => ({
      x: Math.min(width - 1, Math.round(n.coordinates[0] / scale)),
      y: Math.min(height - 1, Math.round(n.coordinates[1] / scale)),
    }));

    const partition = computeProvincePartition(terrain, width, height, seeds);
    const nations: NationStatic[] = raw.map((n, i) => ({
      smallID: i + 1,
      name: n.name,
    }));

    const descriptor: MapDescriptor = {
      id: mapId,
      width,
      height,
      provinceCount: partition.count,
      terrainHash: terrainHashFnv1a(terrain),
    };

    return new StubWorld(descriptor, nations, partition);
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
    if (this.partition.count === 0) return [];

    const changes: [number, number][] = [];
    const start = (this.tick * 7919) % this.partition.count;
    for (let i = 0; i < this.partition.count; i++) {
      const province = (start + i) % this.partition.count;
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
