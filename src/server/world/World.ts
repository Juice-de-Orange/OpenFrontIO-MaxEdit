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

/**
 * Everything needed to put the world back, and nothing that can be derived.
 *
 * The province partition is not in here. It is static map data both sides
 * compute from the same terrain bytes, so storing it would only create a
 * second version of it that could disagree. What *is* stored is enough to
 * detect that disagreement: a snapshot restored against a different map, or a
 * repartitioned one, is refused rather than loaded into a world that would
 * then be quietly wrong everywhere.
 */
export interface WorldSnapshot {
  tick: number;
  mapId: string;
  terrainHash: number;
  provinceCount: number;
  owners: number[];
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
    const mapsDir = path.join(resourcesDir, "maps");
    const dir = path.join(mapsDir, mapId);
    let manifestJson: string;
    try {
      manifestJson = await fs.readFile(
        path.join(dir, "manifest.json"),
        "utf-8",
      );
    } catch {
      // The container image carries only the maps it was built with, so a
      // typo and a missing map look identical from the outside. Say which.
      const available = await fs.readdir(mapsDir).catch(() => []);
      throw new Error(
        `no map named ${mapId} in ${mapsDir}. Available: ` +
          `${available.sort().join(", ") || "none"}`,
      );
    }
    const manifest = JSON.parse(manifestJson) as MapManifest;
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

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      mapId: this.descriptor.id,
      terrainHash: this.descriptor.terrainHash,
      provinceCount: this.partition.count,
      owners: [...this.owners],
    };
  }

  /**
   * Load a snapshot into this world.
   *
   * Every field but `owners` exists to be checked. A snapshot taken on one map
   * and restored onto another has nothing to disagree about on the way in —
   * province ids are just numbers — and the only symptom would be a world that
   * looks plausible and is wrong.
   */
  restoreFrom(snapshot: WorldSnapshot): void {
    if (snapshot.mapId !== this.descriptor.id) {
      throw new Error(
        `snapshot is from map ${snapshot.mapId}, this world is on ${this.descriptor.id}`,
      );
    }
    if (snapshot.terrainHash !== this.descriptor.terrainHash) {
      throw new Error(
        `snapshot terrain hash ${snapshot.terrainHash.toString(16)} does not ` +
          `match this world's ${this.descriptor.terrainHash.toString(16)}`,
      );
    }
    if (snapshot.provinceCount !== this.partition.count) {
      throw new Error(
        `snapshot has ${snapshot.provinceCount} provinces, this world has ${this.partition.count}`,
      );
    }
    if (snapshot.owners.length !== this.owners.length) {
      throw new Error(
        `snapshot owner list is ${snapshot.owners.length} long, expected ${this.owners.length}`,
      );
    }
    for (let i = 0; i < this.owners.length; i++)
      this.owners[i] = snapshot.owners[i];
    this.tick = snapshot.tick;
    this.pending.clear();
  }

  /**
   * A hash of everything the simulation owns.
   *
   * Two worlds with the same hash are the same world. That is the whole
   * assertion a restore has to make, and comparing owner arrays element by
   * element in a log line is not something anyone does twice. FNV-1a, the same
   * function the terrain hash uses.
   */
  stateHash(): number {
    let hash = 0x811c9dc5;
    const mix = (value: number): void => {
      hash ^= value & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (value >>> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (value >>> 16) & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (value >>> 24) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    };
    mix(this.tick);
    for (const owner of this.owners) mix(owner);
    return hash >>> 0;
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

  /**
   * Where the next command would land, without placing it there.
   *
   * The runner writes a command to the log before queueing it, and the two
   * have to agree on tick and seq — the log is the only record of the order
   * commands are applied in.
   */
  peekNextSlot(): QueuedAt {
    const tick = this.tick + 1;
    return { tick, seq: this.pending.get(tick)?.length ?? 0 };
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
