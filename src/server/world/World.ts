/**
 * The world, and the only place its state changes.
 *
 * It owns the province map loaded from disk and who holds each province. Two
 * things move it: player commands, and a deterministic border drift of one
 * province per tick that keeps a world with nobody online from looking frozen.
 *
 * **Everything here is a pure function of (state, tick).** No I/O after load,
 * no wall clock, no Math.random (CLAUDE.md §9). That is not tidiness — it is
 * the entire basis of the restore: replaying the same commands over the same
 * starting state has to land on the same world, or a restart quietly forks the
 * season.
 *
 * **Commands never take effect on arrival.** They are queued for the next tick
 * and revalidated when that tick runs. Applying on arrival would make the
 * result depend on where in the five seconds the packet landed, which is
 * exactly the thing a replay cannot reproduce.
 *
 * **Holding is not owning.** `controller` moves the moment a province is
 * taken; `owner` follows only after the same nation has held it without a
 * break for `OCCUPATION_TICKS` (docs/decisions/0002). Until then it is
 * occupied territory, and retaking it puts it straight back.
 *
 * Phases 3 and up replace the inside of `step()` with the real system order
 * (economy, construction, production, …). The shape does not change: the
 * server holds the authoritative state and emits what changed.
 */

import fs from "fs/promises";
import path from "path";
import { OCCUPATION_TICKS } from "src/shared/config/provinces";
import {
  decodeProvinceMap,
  type ProvinceMap,
  type ProvinceMapMeta,
} from "src/shared/map/ProvinceMap";
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
 * What one tick moved.
 *
 * Two lists rather than one, because they mean different things to a player:
 * control is the front, and ownership is the map. A province usually appears
 * in the first list alone, and in the second one only once, a fortnight later.
 */
export interface WorldChanges {
  /** [provinceId, newController]. */
  control: [number, number][];
  /** [provinceId, newOwner]. */
  owner: [number, number][];
}

/**
 * Everything needed to put the world back, and nothing that can be derived.
 *
 * The province map is not in here. It is static map data checked in beside the
 * terrain bytes, so storing it would only create a second version of it that
 * could disagree. What *is* stored is enough to detect that disagreement: a
 * snapshot restored against a different map, or a regenerated one, is refused
 * rather than loaded into a world that would then be quietly wrong everywhere.
 */
export interface WorldSnapshot {
  tick: number;
  mapId: string;
  terrainHash: number;
  partitionHash: number;
  provinceCount: number;
  owners: number[];
  controllers: number[];
  /** The tick each province's current controller took it. */
  heldSince: number[];
}

export class World {
  private tick = 0;
  private readonly owners: number[];
  private readonly controllers: number[];
  private readonly heldSince: number[];
  private readonly neighbours: number[][];
  /** Commands waiting for the tick they were accepted for. */
  private readonly pending = new Map<number, WorldCommand[]>();

  private constructor(
    readonly descriptor: MapDescriptor,
    readonly nations: NationStatic[],
    readonly map: ProvinceMap,
  ) {
    // Ownership starts from the partition: a province belongs to the nation
    // whose territory it was cut out of, so no province starts split across a
    // border. Slot 0 stays "unowned".
    this.owners = map.provinces.map((province) => province.nation);
    this.controllers = [...this.owners];
    this.heldSince = new Array<number>(this.owners.length).fill(0);
    this.neighbours = map.provinces.map((province) => province.neighbours);
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

    let bin: Buffer;
    let metaJson: string;
    try {
      [bin, metaJson] = await Promise.all([
        fs.readFile(path.join(dir, "provinces.bin")),
        fs.readFile(path.join(dir, "provinces.json"), "utf-8"),
      ]);
    } catch {
      throw new Error(
        `map ${mapId} has no province artefact. Generate it with ` +
          `\`npm run gen-provinces\` and commit it — it is map data, not a ` +
          `build product (docs/decisions/0006)`,
      );
    }
    const provinceMap = decodeProvinceMap(
      new Uint8Array(bin),
      JSON.parse(metaJson) as ProvinceMapMeta,
    );

    // The artefact carries the hash of the terrain it was generated from;
    // hash the terrain in this image and compare. An image built from a
    // half-updated tree — new map bytes, old artefact — otherwise starts
    // cleanly and means something different by every province id.
    const terrain = new Uint8Array(
      await fs.readFile(path.join(dir, "map4x.bin")),
    );
    const terrainHash = terrainHashFnv1a(terrain);
    if (terrainHash !== provinceMap.terrainHash) {
      throw new Error(
        `map ${mapId}: provinces.bin was generated from terrain ` +
          `${provinceMap.terrainHash.toString(16)}, but map4x.bin here hashes ` +
          `to ${terrainHash.toString(16)}. Regenerate with npm run gen-provinces`,
      );
    }

    const nations: NationStatic[] = (manifest.nations ?? []).map((n, i) => ({
      smallID: i + 1,
      name: n.name,
    }));

    const descriptor: MapDescriptor = {
      id: mapId,
      width: provinceMap.width,
      height: provinceMap.height,
      provinceCount: provinceMap.provinceCount,
      terrainHash,
      partitionHash: provinceMap.partitionHash,
    };

    return World.create(descriptor, nations, provinceMap);
  }

  /**
   * A fresh world at tick 0, with every province held by the nation whose
   * territory it was cut out of.
   */
  static create(
    descriptor: MapDescriptor,
    nations: NationStatic[],
    map: ProvinceMap,
  ): World {
    return new World(descriptor, nations, map);
  }

  currentTick(): number {
    return this.tick;
  }

  provinceCount(): number {
    return this.owners.length;
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      mapId: this.descriptor.id,
      terrainHash: this.descriptor.terrainHash,
      partitionHash: this.descriptor.partitionHash,
      provinceCount: this.owners.length,
      owners: [...this.owners],
      controllers: [...this.controllers],
      heldSince: [...this.heldSince],
    };
  }

  /**
   * Load a snapshot into this world.
   *
   * Every field but the three arrays exists to be checked. A snapshot taken on
   * one map and restored onto another has nothing to disagree about on the way
   * in — province ids are just numbers — and the only symptom would be a world
   * that looks plausible and is wrong.
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
    if (snapshot.partitionHash !== this.descriptor.partitionHash) {
      throw new Error(
        `snapshot was taken on province artefact ` +
          `${snapshot.partitionHash.toString(16)}, this world runs on ` +
          `${this.descriptor.partitionHash.toString(16)}; the province ids do ` +
          `not mean the same places`,
      );
    }
    if (snapshot.provinceCount !== this.owners.length) {
      throw new Error(
        `snapshot has ${snapshot.provinceCount} provinces, this world has ${this.owners.length}`,
      );
    }
    for (const [name, list] of [
      ["owner", snapshot.owners],
      ["controller", snapshot.controllers],
      ["heldSince", snapshot.heldSince],
    ] as const) {
      if (list.length !== this.owners.length) {
        throw new Error(
          `snapshot ${name} list is ${list.length} long, expected ${this.owners.length}`,
        );
      }
    }

    for (let i = 0; i < this.owners.length; i++) {
      this.owners[i] = snapshot.owners[i];
      this.controllers[i] = snapshot.controllers[i];
      this.heldSince[i] = snapshot.heldSince[i];
    }
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
   *
   * **Every field of the state goes in.** A field left out is a field the
   * restore test cannot see, and it will pass over a world that came back half
   * right.
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
    for (const controller of this.controllers) mix(controller);
    for (const since of this.heldSince) mix(since);
    return hash >>> 0;
  }

  ownerSnapshot(): number[] {
    return [...this.owners];
  }

  controllerSnapshot(): number[] {
    return [...this.controllers];
  }

  ownerOf(province: number): number {
    return this.owners[province];
  }

  controllerOf(province: number): number {
    return this.controllers[province];
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
        if (province < 0 || province >= this.owners.length) {
          return `no province ${province} on this map`;
        }
        // Control, not ownership: a nation fights from where its troops are,
        // not from where its title deeds are.
        if (this.controllers[province] === nation) {
          return "province is already yours";
        }
        const adjacent = this.neighbours[province].some(
          (n) => this.controllers[n] === nation,
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
   * Commands first, then the drift, then occupation: a player order for this
   * tick is resolved against the world as it was left by the previous one, not
   * against a world the drift has already moved underneath it.
   *
   * Deterministic sweep rather than a random pick: the tick has to be
   * reproducible from the log, which is what the restore depends on.
   * No Math.random() anywhere near world state — CLAUDE.md §9.
   */
  step(): WorldChanges {
    this.tick++;
    const changes: WorldChanges = { control: [], owner: [] };

    const commands = this.pending.get(this.tick);
    if (commands !== undefined) {
      this.pending.delete(this.tick);
      for (const command of commands) {
        // Revalidated, because the world moved since the command was accepted.
        // A claim whose foothold was lost in the meantime does nothing; it is
        // not an error, and it is the same nothing on every replay.
        if (this.rejectionFor(command) !== null) continue;
        this.takeControl(command.body.provinceId, command.nation, changes);
      }
    }

    this.drift(changes);
    this.settleOccupation(changes);
    return changes;
  }

  /** One province changes hands at a border. The world's heartbeat. */
  private drift(changes: WorldChanges): void {
    const count = this.owners.length;
    if (count === 0) return;

    // The drift never touches a province a command just moved. A heartbeat
    // that can undo a player's order in the same tick it lands would be
    // indistinguishable, from the player's side, from the order being lost.
    const claimed = new Set(changes.control.map(([province]) => province));
    const start = (this.tick * 7919) % count;
    for (let i = 0; i < count; i++) {
      const province = (start + i) % count;
      if (claimed.has(province)) continue;
      const mine = this.controllers[province];
      const taker = this.neighbours[province].find(
        (n) => this.controllers[n] !== mine && this.controllers[n] !== 0,
      );
      if (taker !== undefined) {
        this.takeControl(province, this.controllers[taker], changes);
        break;
      }
    }
  }

  /**
   * Ownership catches up with control, a fortnight late.
   *
   * A province whose controller has held it without a break for
   * `OCCUPATION_TICKS` stops being occupied and becomes theirs. Retaking it
   * before then resets the clock, which is what makes holding ground cost
   * something separate from taking it (docs/decisions/0002).
   */
  private settleOccupation(changes: WorldChanges): void {
    for (let province = 0; province < this.owners.length; province++) {
      const controller = this.controllers[province];
      if (controller === this.owners[province]) continue;
      if (this.tick - this.heldSince[province] < OCCUPATION_TICKS) continue;
      this.owners[province] = controller;
      changes.owner.push([province, controller]);
    }
  }

  private takeControl(
    province: number,
    nation: number,
    changes: WorldChanges,
  ): void {
    if (this.controllers[province] === nation) return;
    this.controllers[province] = nation;
    this.heldSince[province] = this.tick;
    changes.control.push([province, nation]);
  }
}
