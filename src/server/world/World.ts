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
import type { Resource } from "src/shared/config/provinces";
import { OCCUPATION_TICKS, RESOURCES } from "src/shared/config/provinces";
import {
  STARTING_CAPITAL_BUILDINGS,
  STARTING_RESOURCES,
} from "src/shared/config/rates";
import {
  buildingIndex,
  BUILDINGS,
  type BuildingType,
} from "src/shared/economy/Buildings";
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
import { SYSTEMS } from "../systems";
import { measureNation, type NationEconomy } from "../systems/economy";
import {
  applyEvent,
  countBuilding,
  createWorldState,
  effectiveInfrastructure,
  usedSlots,
  type ConstructionOrder,
  type WorldEvent,
  type WorldState,
} from "./WorldState";

/** A queue nobody could work through is a queue used as a memory leak. */
const MAX_QUEUE_LENGTH = 24;

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
  /** [provinceId, buildingIndex, newCount] — only what finished this tick. */
  buildings: [number, number, number][];
  /**
   * Every event the tick produced, in order.
   *
   * Not sent anywhere yet. It is here because the event log is the thing that
   * makes a tick explainable after the fact, and the socket layer is where it
   * will be filtered per nation when there is something to filter.
   */
  events: WorldEvent[];
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
  /** Flat, `province * BUILDING_TYPES.length + type`. */
  buildings: number[];
  /** Per nation, index 0 unused so a nation id indexes it directly. */
  nations: {
    resources: Record<Resource, number>;
    constructionQueue: ConstructionOrder[];
  }[];
}

/** One buffer, reused: `stateHash` mixes a double's two words exactly. */
const HASH_FLOAT = new Float64Array(1);
const HASH_WORDS = new Uint32Array(HASH_FLOAT.buffer);

export class World {
  private readonly state: WorldState;
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
    this.state = createWorldState(map, nations.length, {
      capitalBuildings: STARTING_CAPITAL_BUILDINGS,
      resources: STARTING_RESOURCES,
    });
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
    return this.state.tick;
  }

  provinceCount(): number {
    return this.state.provinceOwner.length;
  }

  /** Read-only for everything outside this class. Only events may write it. */
  view(): Readonly<WorldState> {
    return this.state;
  }

  /** What a nation's economy is doing right now. Pure, and not stored. */
  economyOf(nation: number): NationEconomy {
    return measureNation(this.state, nation);
  }

  constructionQueueOf(nation: number): readonly ConstructionOrder[] {
    return this.state.nations[nation]?.constructionQueue ?? [];
  }

  /** Flat building counts, in the layout the snapshot and the wire both use. */
  buildingSnapshot(): number[] {
    return [...this.state.buildings];
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.state.tick,
      mapId: this.descriptor.id,
      terrainHash: this.descriptor.terrainHash,
      partitionHash: this.descriptor.partitionHash,
      provinceCount: this.state.provinceOwner.length,
      owners: [...this.state.provinceOwner],
      controllers: [...this.state.provinceController],
      heldSince: [...this.state.provinceHeldSince],
      buildings: [...this.state.buildings],
      nations: this.state.nations.map((nation) => ({
        resources: { ...nation.resources },
        constructionQueue: nation.constructionQueue.map((order) => ({
          ...order,
        })),
      })),
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
    const count = this.state.provinceOwner.length;
    if (snapshot.provinceCount !== count) {
      throw new Error(
        `snapshot has ${snapshot.provinceCount} provinces, this world has ${count}`,
      );
    }
    for (const [name, list] of [
      ["owner", snapshot.owners],
      ["controller", snapshot.controllers],
      ["heldSince", snapshot.heldSince],
    ] as const) {
      if (list.length !== count) {
        throw new Error(
          `snapshot ${name} list is ${list.length} long, expected ${count}`,
        );
      }
    }
    if (snapshot.buildings.length !== this.state.buildings.length) {
      throw new Error(
        `snapshot has ${snapshot.buildings.length} building slots, this world ` +
          `has ${this.state.buildings.length}; the building type list changed ` +
          `underneath a running world`,
      );
    }
    if (snapshot.nations.length !== this.state.nations.length) {
      throw new Error(
        `snapshot has ${snapshot.nations.length} nation records, this world ` +
          `has ${this.state.nations.length}`,
      );
    }

    for (let i = 0; i < count; i++) {
      this.state.provinceOwner[i] = snapshot.owners[i];
      this.state.provinceController[i] = snapshot.controllers[i];
      this.state.provinceHeldSince[i] = snapshot.heldSince[i];
    }
    this.state.buildings.set(snapshot.buildings);
    for (let nation = 0; nation < snapshot.nations.length; nation++) {
      const stored = snapshot.nations[nation];
      const live = this.state.nations[nation];
      for (const resource of RESOURCES) {
        live.resources[resource] = stored.resources[resource] ?? 0;
      }
      live.constructionQueue = stored.constructionQueue.map((order) => ({
        ...order,
      }));
    }
    this.state.tick = snapshot.tick;
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
    // A float has to go in exactly, not rounded: a stockpile that came back
    // 0.0001 short is a world that has diverged, and rounding it into the hash
    // is how the restore test would learn to say nothing about it. Both halves
    // of the double, through a shared view.
    const mixFloat = (value: number): void => {
      HASH_FLOAT[0] = value;
      mix(HASH_WORDS[0]);
      mix(HASH_WORDS[1]);
    };

    mix(this.state.tick);
    for (const owner of this.state.provinceOwner) mix(owner);
    for (const controller of this.state.provinceController) mix(controller);
    for (const since of this.state.provinceHeldSince) mix(since);
    for (const count of this.state.buildings) mix(count);
    for (const nation of this.state.nations) {
      for (const resource of RESOURCES) mixFloat(nation.resources[resource]);
      mix(nation.constructionQueue.length);
      for (const order of nation.constructionQueue) {
        mix(order.provinceId);
        mix(buildingIndex(order.building));
        mixFloat(order.progress);
      }
    }
    return hash >>> 0;
  }

  ownerSnapshot(): number[] {
    return [...this.state.provinceOwner];
  }

  controllerSnapshot(): number[] {
    return [...this.state.provinceController];
  }

  ownerOf(province: number): number {
    return this.state.provinceOwner[province];
  }

  controllerOf(province: number): number {
    return this.state.provinceController[province];
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
        if (!this.hasProvince(province)) {
          return `no province ${province} on this map`;
        }
        // Control, not ownership: a nation fights from where its troops are,
        // not from where its title deeds are.
        if (this.state.provinceController[province] === nation) {
          return "province is already yours";
        }
        const adjacent = this.neighbours[province].some(
          (n) => this.state.provinceController[n] === nation,
        );
        if (!adjacent) return "province does not border your territory";
        return null;
      }

      case "queue_construction":
        return this.rejectionForQueue(nation, body.provinceId, body.building);

      case "cancel_construction": {
        const queue = this.state.nations[nation].constructionQueue;
        if (!queue.some((order) => order.id === body.orderId)) {
          return `you have no construction order ${body.orderId}`;
        }
        return null;
      }
    }
  }

  /**
   * Build orders this nation has had accepted but not yet applied.
   *
   * Only ever non-empty between a command being accepted and its tick running.
   * Returned in the same shape as a queue entry so the limit checks can treat
   * the two together.
   */
  private pendingOrders(nation: number): ConstructionOrder[] {
    const orders: ConstructionOrder[] = [];
    for (const commands of this.pending.values()) {
      for (const command of commands) {
        if (command.nation !== nation) continue;
        if (command.body.kind !== "queue_construction") continue;
        orders.push({
          id: 0,
          provinceId: command.body.provinceId,
          building: command.body.building,
          progress: 0,
        });
      }
    }
    return orders;
  }

  private hasProvince(province: number): boolean {
    return (
      Number.isInteger(province) &&
      province >= 0 &&
      province < this.state.provinceOwner.length
    );
  }

  /**
   * Whether this nation may put this building in this province.
   *
   * Every check here is the server's own: CLAUDE.md §7 — never trust a
   * client-supplied cost, position or outcome. The client has the same
   * `BUILDINGS` table and computes the same answer for its build menu, and
   * that copy is decoration.
   *
   * Queued orders count against the limits. Without that, a player queues ten
   * factories into a province with two free slots, watches eight of them
   * complete into nothing, and has spent a week of construction points on a
   * rule the UI told them they were obeying.
   */
  private rejectionForQueue(
    nation: number,
    province: number,
    building: BuildingType,
  ): string | null {
    if (!this.hasProvince(province)) {
      return `no province ${province} on this map`;
    }
    const spec = BUILDINGS[building];
    if (spec === undefined) return `there is no such building as ${building}`;

    // Orders already in the queue, **plus** commands accepted this tick that
    // have not been applied yet. Without the second, three build orders sent
    // in the same five seconds are all validated against an empty queue, all
    // acked "accepted for tick N", and the surplus is then silently skipped
    // when the tick runs. That is the failure CLAUDE.md §7 is written against:
    // the player sees nothing happen and cannot tell a refused order from a
    // lost packet.
    //
    // At apply time this counts nothing, and correctly so — `step` removes the
    // tick's commands from `pending` before running them, so everything
    // earlier in the tick is already in the queue.
    const queue = this.state.nations[nation].constructionQueue;
    const alsoPending = this.pendingOrders(nation);
    if (queue.length + alsoPending.length >= MAX_QUEUE_LENGTH) {
      return `your construction queue is full (${MAX_QUEUE_LENGTH})`;
    }

    // Held *and* owned. Building a factory in territory you are occupying is
    // not a thing a nation does, and it would also hand the province's new
    // owner a free factory when the occupation transfers.
    if (this.state.provinceController[province] !== nation) {
      return "you do not hold that province";
    }
    if (this.state.provinceOwner[province] !== nation) {
      return "that province is occupied territory, not yours to build in";
    }

    const info = this.map.provinces[province];
    if (spec.coastalOnly && !info.coastal) {
      return "that can only be built in a coastal province";
    }

    const queuedHere = [...queue, ...alsoPending].filter(
      (order) => order.provinceId === province,
    );

    if (spec.takesSlot) {
      const pending = queuedHere.filter(
        (order) => BUILDINGS[order.building].takesSlot,
      ).length;
      if (usedSlots(this.state, province) + pending >= info.buildingSlots) {
        return `province ${province} has no free building slot`;
      }
    }

    if (spec.maxPerProvince !== undefined) {
      const pending = queuedHere.filter(
        (order) => order.building === building,
      ).length;
      const existing =
        building === "infrastructure"
          ? effectiveInfrastructure(this.state, province)
          : countBuilding(this.state, province, building);
      if (existing + pending >= spec.maxPerProvince) {
        return `province ${province} is already at the limit for ${building}`;
      }
    }

    return null;
  }

  /**
   * Accept a command for the next tick.
   *
   * The caller must have written it to the log first. `seq` is its position
   * within that tick: two commands on the same tick have to be replayed in the
   * order they were accepted, and nothing else records that order.
   */
  queueCommand(command: WorldCommand): QueuedAt {
    return this.enqueueAt(this.state.tick + 1, command);
  }

  /**
   * Where the next command would land, without placing it there.
   *
   * The runner writes a command to the log before queueing it, and the two
   * have to agree on tick and seq — the log is the only record of the order
   * commands are applied in.
   */
  peekNextSlot(): QueuedAt {
    const tick = this.state.tick + 1;
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
   * Commands first, then the systems in the order CLAUDE.md §6 fixes, then the
   * drift and the occupation clock. A player order for this tick is resolved
   * against the world as it was left by the previous one, not against a world
   * something else has already moved underneath it.
   *
   * **Every mutation goes through an event**, and each system's events are
   * applied before the next system runs (docs/decisions/0007). Deterministic
   * throughout: the tick has to be reproducible from the log, which is what
   * the restore depends on. No Math.random() anywhere near world state —
   * CLAUDE.md §9.
   */
  step(): WorldChanges {
    this.state.tick++;
    const changes: WorldChanges = {
      control: [],
      owner: [],
      buildings: [],
      events: [],
    };

    const commands = this.pending.get(this.state.tick);
    if (commands !== undefined) {
      this.pending.delete(this.state.tick);
      for (const command of commands) {
        // Revalidated, because the world moved since the command was accepted.
        // A claim whose foothold was lost in the meantime does nothing; it is
        // not an error, and it is the same nothing on every replay.
        if (this.rejectionFor(command) !== null) continue;
        this.emit(this.eventsForCommand(command), changes);
      }
    }

    for (const system of SYSTEMS) {
      this.emit(system.run(this.state, this.state.tick), changes);
    }

    this.drift(changes);
    this.settleOccupation(changes);
    return changes;
  }

  /** Apply events in order and record what a client would need to hear. */
  private emit(events: WorldEvent[], changes: WorldChanges): void {
    for (const event of events) {
      applyEvent(this.state, event);
      changes.events.push(event);
      switch (event.kind) {
        case "control_changed":
          changes.control.push([event.province, event.nation]);
          break;
        case "owner_changed":
          changes.owner.push([event.province, event.nation]);
          break;
        case "construction_finished":
          changes.buildings.push([
            event.province,
            buildingIndex(event.building),
            countBuilding(this.state, event.province, event.building),
          ]);
          break;
        default:
          break;
      }
    }
  }

  private eventsForCommand(command: WorldCommand): WorldEvent[] {
    const { nation, body } = command;
    switch (body.kind) {
      case "claim_province":
        return [{ kind: "control_changed", province: body.provinceId, nation }];
      case "queue_construction":
        return [
          {
            kind: "construction_queued",
            nation,
            order: {
              provinceId: body.provinceId,
              building: body.building,
              progress: 0,
            },
          },
        ];
      case "cancel_construction":
        return [
          { kind: "construction_cancelled", nation, orderId: body.orderId },
        ];
    }
  }

  /** One province changes hands at a border. The world's heartbeat. */
  private drift(changes: WorldChanges): void {
    const count = this.state.provinceOwner.length;
    if (count === 0) return;

    // The drift never touches a province a command just moved. A heartbeat
    // that can undo a player's order in the same tick it lands would be
    // indistinguishable, from the player's side, from the order being lost.
    const claimed = new Set(changes.control.map(([province]) => province));
    const start = (this.state.tick * 7919) % count;
    for (let i = 0; i < count; i++) {
      const province = (start + i) % count;
      if (claimed.has(province)) continue;
      const mine = this.state.provinceController[province];
      const taker = this.neighbours[province].find(
        (n) =>
          this.state.provinceController[n] !== mine &&
          this.state.provinceController[n] !== 0,
      );
      if (taker !== undefined) {
        this.takeControl(
          province,
          this.state.provinceController[taker],
          changes,
        );
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
    const events: WorldEvent[] = [];
    for (
      let province = 0;
      province < this.state.provinceOwner.length;
      province++
    ) {
      const controller = this.state.provinceController[province];
      if (controller === this.state.provinceOwner[province]) continue;
      if (
        this.state.tick - this.state.provinceHeldSince[province] <
        OCCUPATION_TICKS
      ) {
        continue;
      }
      events.push({ kind: "owner_changed", province, nation: controller });
    }
    this.emit(events, changes);
  }

  private takeControl(
    province: number,
    nation: number,
    changes: WorldChanges,
  ): void {
    if (this.state.provinceController[province] === nation) return;
    this.emit([{ kind: "control_changed", province, nation }], changes);
  }
}
