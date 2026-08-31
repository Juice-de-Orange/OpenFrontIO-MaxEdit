/**
 * The world's state, and the only thing that may change it.
 *
 * Split out of `World` in phase 3, because from here on the state is not eight
 * hundred numbers any more: it is provinces, buildings, stockpiles and
 * construction queues, and a dozen systems will want to read it without being
 * able to reach into the class that owns it.
 *
 * Three rules hold everything together, and they are the reason a tick can be
 * replayed from the log six weeks later and land on the same world:
 *
 * **Events are the only mutation.** Nothing outside `applyEvent` writes to a
 * field of this object. A system returns events; it never assigns.
 *
 * **Everything is a rate.** No event adds a lump sum. Construction accrues,
 * extraction accrues, and a building appears only when its accrued progress
 * passes its cost (invariant 1).
 *
 * **Nothing derived is stored.** Output rates, slot usage and effective
 * infrastructure are functions of what is here, computed where they are
 * needed. A stored copy is a copy that can disagree — and, worse, one that has
 * to be in the snapshot and in the state hash to be safe, which makes the
 * restore test protect a number that never mattered.
 */

import type { Resource } from "src/shared/config/provinces";
import { RESOURCES } from "src/shared/config/provinces";
import { RESOURCE_CAP } from "src/shared/config/rates";
import {
  BUILDING_TYPES,
  buildingIndex,
  BUILDINGS,
  type BuildingType,
} from "src/shared/economy/Buildings";
import type { ProvinceMap } from "src/shared/map/ProvinceMap";

/** One item in a nation's construction queue. */
export interface ConstructionOrder {
  /**
   * Stable for the life of the order, and unique within the nation.
   *
   * The queue used to be addressed by position, and two cancellations sent in
   * the same five seconds then cancelled the wrong things: the first shifts
   * the queue, so the second removes whatever has moved into that slot — or is
   * refused as out of range, leaving the player with an "accepted" ack and an
   * order still sitting there. Positions are what a player clicks; they are
   * not what a command should carry.
   */
  id: number;
  provinceId: number;
  building: BuildingType;
  /** Construction points accrued. Persists; nothing here completes at once. */
  progress: number;
}

export interface NationState {
  resources: Record<Resource, number>;
  constructionQueue: ConstructionOrder[];
  /**
   * The id the next order will get. Monotonic, never reused.
   *
   * In the snapshot and in the state hash, because a restore that handed out
   * an id twice would give a nation two orders a cancellation cannot tell
   * apart.
   */
  nextOrderId: number;
}

export interface WorldState {
  tick: number;
  readonly map: ProvinceMap;
  /** Number of nations; ids run 1..nationCount, with 0 meaning unowned. */
  readonly nationCount: number;

  provinceOwner: number[];
  provinceController: number[];
  /** The tick each province's current controller took it. */
  provinceHeldSince: number[];

  /**
   * Buildings, flat: `buildings[province * BUILDING_TYPES.length + type]`.
   *
   * One array rather than an object per province. Europe is 529 provinces and
   * ten types — 5,290 bytes, one allocation, and a snapshot that is a list of
   * small integers instead of five hundred sparse objects.
   */
  buildings: Uint8Array;

  /** Index 0 is unused, so a nation id indexes this directly. */
  nations: NationState[];
}

export function buildingsStride(): number {
  return BUILDING_TYPES.length;
}

export function countBuilding(
  state: WorldState,
  province: number,
  type: BuildingType,
): number {
  return state.buildings[
    province * BUILDING_TYPES.length + buildingIndex(type)
  ];
}

/** How many of the province's slots are taken. Levels do not take one. */
export function usedSlots(state: WorldState, province: number): number {
  let used = 0;
  const base = province * BUILDING_TYPES.length;
  for (let i = 0; i < BUILDING_TYPES.length; i++) {
    if (BUILDINGS[BUILDING_TYPES[i]].takesSlot)
      used += state.buildings[base + i];
  }
  return used;
}

/**
 * A province's infrastructure as it stands: what the map gave it, plus what
 * has been built, capped where the spec caps it.
 *
 * Derived rather than stored, so the artefact stays the single source of the
 * starting value and the built levels stay in the same array as everything
 * else that was constructed.
 */
export function effectiveInfrastructure(
  state: WorldState,
  province: number,
): number {
  const built = countBuilding(state, province, "infrastructure");
  const cap = BUILDINGS.infrastructure.maxPerProvince ?? 10;
  return Math.min(cap, state.map.provinces[province].infrastructure + built);
}

/** A fresh world: every province with its starting owner, capitals equipped. */
export function createWorldState(
  map: ProvinceMap,
  nationCount: number,
  starting: {
    capitalBuildings: Readonly<Record<string, number>>;
    resources: Record<Resource, number>;
  },
): WorldState {
  const owner = map.provinces.map((province) => province.nation);
  const state: WorldState = {
    tick: 0,
    map,
    nationCount,
    provinceOwner: owner,
    provinceController: [...owner],
    provinceHeldSince: new Array<number>(owner.length).fill(0),
    buildings: new Uint8Array(owner.length * BUILDING_TYPES.length),
    nations: [],
  };

  // Slot 0 exists so a nation id indexes the array directly. It is never read.
  for (let nation = 0; nation <= nationCount; nation++) {
    state.nations.push({
      resources: { ...starting.resources },
      constructionQueue: [],
      nextOrderId: 1,
    });
  }

  for (const province of map.provinces) {
    if (!province.capital) continue;
    for (const [type, count] of Object.entries(starting.capitalBuildings)) {
      const index = buildingIndex(type as BuildingType);
      if (index < 0) continue;
      state.buildings[province.id * BUILDING_TYPES.length + index] = count;
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Everything that can happen to the world.
 *
 * A closed union on purpose: adding a way for the world to change means adding
 * a case here and a case in the reducer, and the compiler will not let the
 * second be forgotten.
 */
export type WorldEvent =
  | { kind: "control_changed"; province: number; nation: number }
  | { kind: "owner_changed"; province: number; nation: number }
  | {
      kind: "resources_changed";
      nation: number;
      /** Signed, per resource. Applied and then clamped to [0, RESOURCE_CAP]. */
      delta: Partial<Record<Resource, number>>;
    }
  | {
      kind: "construction_queued";
      nation: number;
      /** Without its id: the reducer assigns one, so a replay assigns the same. */
      order: Omit<ConstructionOrder, "id">;
    }
  | { kind: "construction_cancelled"; nation: number; orderId: number }
  | {
      kind: "construction_progressed";
      nation: number;
      index: number;
      points: number;
    }
  | {
      kind: "construction_finished";
      nation: number;
      index: number;
      province: number;
      building: BuildingType;
    };

/**
 * Apply one event. The only writer of this object.
 *
 * Applied immediately after the system that emitted it, not at the end of the
 * tick — see docs/decisions/0007. The order in CLAUDE.md §6 only means
 * anything if a later system sees what an earlier one did.
 */
export function applyEvent(state: WorldState, event: WorldEvent): void {
  switch (event.kind) {
    case "control_changed":
      state.provinceController[event.province] = event.nation;
      state.provinceHeldSince[event.province] = state.tick;
      return;

    case "owner_changed":
      state.provinceOwner[event.province] = event.nation;
      return;

    case "resources_changed": {
      const resources = state.nations[event.nation].resources;
      for (const resource of RESOURCES) {
        const change = event.delta[resource];
        if (change === undefined) continue;
        // Clamped both ends. Negative is the one that matters: a rounding
        // error that took a stockpile below zero would make every later
        // sufficiency calculation nonsense, silently.
        resources[resource] = Math.max(
          0,
          Math.min(RESOURCE_CAP, resources[resource] + change),
        );
      }
      return;
    }

    case "construction_queued": {
      // The id is assigned here, not by the caller, so a replay of the same
      // command log hands out the same ids in the same order.
      const nation = state.nations[event.nation];
      nation.constructionQueue.push({
        ...event.order,
        id: nation.nextOrderId++,
      });
      return;
    }

    case "construction_cancelled": {
      const queue = state.nations[event.nation].constructionQueue;
      const at = queue.findIndex((order) => order.id === event.orderId);
      if (at >= 0) queue.splice(at, 1);
      return;
    }

    case "construction_progressed": {
      const order = state.nations[event.nation].constructionQueue[event.index];
      if (order !== undefined) order.progress += event.points;
      return;
    }

    case "construction_finished": {
      const nation = state.nations[event.nation];
      nation.constructionQueue.splice(event.index, 1);
      const at =
        event.province * BUILDING_TYPES.length + buildingIndex(event.building);
      // Uint8Array wraps at 256. Nothing can reach it — slots cap at ten and
      // levels lower — but a saturating add costs nothing and a wrapped
      // building count is the kind of bug that looks like a UI fault.
      state.buildings[at] = Math.min(255, state.buildings[at] + 1);
      return;
    }
  }
}
