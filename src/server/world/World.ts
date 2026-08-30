/**
 * The world, and the only place its state changes.
 *
 * It owns the map, the province partition derived from it, and who holds each
 * province. Two things move it: player commands, and a deterministic border
 * drift of one province per tick that keeps a world with nobody online from
 * looking frozen.
 *
 * **Everything here is a pure function of (state, tick).** No I/O, no wall
 * clock, no Math.random (CLAUDE.md §9). That is not tidiness — it is the
 * entire basis of the restore: replaying the same commands over the same
 * starting state has to land on the same world, or a restart quietly forks the
 * season.
 *
 * **Commands never take effect on arrival.** They are queued for the next tick
 * and revalidated when that tick runs. Applying on arrival would make the
 * result depend on where in the five seconds the packet landed, which is
 * exactly the thing a replay cannot reproduce.
 *
 * Phases 3 and up replace the inside of `step()` with the real system order
 * (economy, construction, production, …). The shape does not change: the
 * server holds the authoritative state and emits what changed.
 */

import fs from "fs/promises";
import path from "path";
import {
  computeProvincePartition,
  type ProvincePartition,
} from "src/shared/map/ProvincePartition";
import { terrainHashFnv1a } from "src/shared/map/TerrainHash";
import type {
  CommandBody,
  MapDescriptor,
  NationStatic,
} from "src/shared/protocol/Wire";

interface ManifestNation {
  name: string;
  coordinates: [number, number];
}

interface MapManifest {
  map: { width: number; height: number };
  map4x: { width: number; height: number };
  nations?: ManifestNation[];
}

/** A command as the world sees it: a body, and who ordered it. */
export interface WorldCommand {
  nation: number;
  body: CommandBody;
}

/** Where an accepted command was placed in the log. */
export interface QueuedAt {
  tick: number;
  seq: number;
}

export class World {
  private tick = 0;
  private readonly owners: number[];
  private readonly neighbours: number[][];
  /** Commands waiting for the tick they were accepted for. */
  private readonly pending = new Map<number, WorldCommand[]>();

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

  static async load(mapId: string, resourcesDir: string): Promise<World> {
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

    return World.create(descriptor, nations, partition);
  }

  /**
   * A fresh world at tick 0, with every province held by the nation whose
   * territory it was cut out of.
   */
  static create(
    descriptor: MapDescriptor,
    nations: NationStatic[],
    partition: ProvincePartition,
  ): World {
    return new World(descriptor, nations, partition);
  }

  currentTick(): number {
    return this.tick;
  }

  ownerSnapshot(): number[] {
    return [...this.owners];
  }

  ownerOf(province: number): number {
    return this.owners[province];
  }

  /**
   * Why this command cannot be accepted, or null if it can.
   *
   * Run twice on purpose: once when the command arrives, so the player is told
   * immediately and nothing unusable reaches the log; and again on the tick it
   * applies, because the world moves in between. The second run is what a
   * replay reproduces — it depends only on state and tick.
   */
  rejectionFor(command: WorldCommand): string | null {
    const { nation, body } = command;
    if (
      !Number.isInteger(nation) ||
      nation < 1 ||
      nation > this.nations.length
    ) {
      return `no nation ${nation} in this world`;
    }
    switch (body.kind) {
      case "claim_province": {
        const province = body.provinceId;
        if (province < 0 || province >= this.partition.count) {
          return `no province ${province} on this map`;
        }
        if (this.owners[province] === nation) {
          return "province is already yours";
        }
        const adjacent = this.neighbours[province].some(
          (n) => this.owners[n] === nation,
        );
        if (!adjacent) return "province does not border your territory";
        return null;
      }
    }
  }

  /**
   * Accept a command for the next tick.
   *
   * The caller must have written it to the log first. `seq` is its position
   * within that tick: two commands on the same tick have to be replayed in the
   * order they were accepted, and nothing else records that order.
   */
  queueCommand(command: WorldCommand): QueuedAt {
    return this.enqueueAt(this.tick + 1, command);
  }

  /** Place a command on a specific tick. Used by queueCommand and by replay. */
  enqueueAt(tick: number, command: WorldCommand): QueuedAt {
    const queue = this.pending.get(tick);
    if (queue === undefined) {
      this.pending.set(tick, [command]);
      return { tick, seq: 0 };
    }
    queue.push(command);
    return { tick, seq: queue.length - 1 };
  }

  /**
   * Advance one tick and return what changed.
   *
   * Commands first, then the drift: a player order for this tick is resolved
   * against the world as it was left by the previous one, not against a world
   * the drift has already moved underneath it.
   *
   * Deterministic sweep rather than a random pick: the tick has to be
   * reproducible from the log, which is what the restore depends on.
   * No Math.random() anywhere near world state — CLAUDE.md §9.
   */
  step(): [number, number][] {
    this.tick++;
    const changes: [number, number][] = [];

    const commands = this.pending.get(this.tick);
    if (commands !== undefined) {
      this.pending.delete(this.tick);
      for (const command of commands) {
        // Revalidated, because the world moved since the command was accepted.
        // A claim whose foothold was lost in the meantime does nothing; it is
        // not an error, and it is the same nothing on every replay.
        if (this.rejectionFor(command) !== null) continue;
        const province = command.body.provinceId;
        this.owners[province] = command.nation;
        changes.push([province, command.nation]);
      }
    }

    if (this.partition.count === 0) return changes;

    // The drift never touches a province a command just moved. A heartbeat
    // that can undo a player's order in the same tick it lands would be
    // indistinguishable, from the player's side, from the order being lost.
    const claimed = new Set(changes.map(([province]) => province));
    const start = (this.tick * 7919) % this.partition.count;
    for (let i = 0; i < this.partition.count; i++) {
      const province = (start + i) % this.partition.count;
      if (claimed.has(province)) continue;
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
