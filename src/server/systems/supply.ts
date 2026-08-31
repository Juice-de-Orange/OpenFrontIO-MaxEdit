/**
 * Supply over the province graph: how far a nation can fight from its hubs.
 *
 * §6.6, land only — the sea path is stubbed until phase 9 gives convoys
 * something to be sunk by. Two numbers decide what a division gets, and they
 * fail in different directions on purpose:
 *
 * - **Reach**, from a weighted shortest path over provinces the nation
 *   controls. It falls with distance from the nearest source and rises with
 *   the infrastructure along the way. This is what punishes an offensive that
 *   has outrun its hubs.
 * - **Coverage**, the nation's total source throughput against its total
 *   demand. This is what punishes an army too big for the hubs behind it.
 *
 * A division's supply is the product. Neither term ever refuses anything: a
 * province out of range is badly supplied, not unreachable, and a nation with
 * too many divisions has weaker ones rather than fewer (invariant 2).
 *
 * **There is no cache, and that is a measured decision rather than an
 * oversight.** §6.6 warns against recomputing the full network every tick and
 * asks for a cache with recompute triggers. On this map the full recompute for
 * every nation is a single pass over the province graph — each nation's search
 * only ever visits provinces it controls, so all fifty-two of them together
 * visit 529 provinces once. `tests/server/Supply.test.ts` measures it against
 * §8's 50 ms budget and it is not close. A cache would be state that has to be
 * in the snapshot and in the state hash, or module state that makes a replay
 * depend on how the process was started; neither is worth buying speed nobody
 * needs. Revisit it if a map arrives with ten times the provinces.
 */

import {
  SUPPLY_ATTRITION,
  SUPPLY_HOP_COST,
  SUPPLY_INFRASTRUCTURE_RELIEF,
  SUPPLY_MIN_HOP_COST,
  SUPPLY_PER_DIVISION,
  SUPPLY_RANGE,
  SUPPLY_SOURCE_THROUGHPUT,
} from "src/shared/config/supply";
import type { System } from ".";
import {
  countBuilding,
  effectiveInfrastructure,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";

/**
 * Provinces a nation draws supply from: its capitals, and its supply hubs.
 *
 * A capital counts because a nation with no hubs at all should still be able
 * to fight at home — a first division that starves the tick it is raised
 * would be a wall, and there are none of those here.
 */
export function supplySources(state: WorldState, nation: number): number[] {
  const sources: number[] = [];
  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] !== nation) continue;
    if (state.provinceOwner[province] !== nation) continue;
    if (
      state.map.provinces[province].capital ||
      countBuilding(state, province, "supply_hub") > 0
    ) {
      sources.push(province);
    }
  }
  return sources;
}

/**
 * How well each province the nation holds is reached, 0..1.
 *
 * A multi-source weighted shortest path, relaxed with a simple queue rather
 * than a heap: the graph is 529 nodes with a mean degree of three and the
 * costs are all within a factor of three of each other, so the queue settles
 * in a couple of passes and a heap would be more code for no time.
 *
 * Only provinces the nation **controls** conduct supply. Ground you do not
 * hold is not a road you can use, and this is what makes an offensive that
 * bypasses a pocket pay for it.
 */
export function supplyReach(
  state: WorldState,
  nation: number,
): Map<number, number> {
  const cost = new Map<number, number>();
  const queue = supplySources(state, nation);
  for (const source of queue) cost.set(source, 0);

  for (let head = 0; head < queue.length; head++) {
    const province = queue[head];
    const here = cost.get(province) ?? Infinity;
    for (const next of state.map.provinces[province].neighbours) {
      if (state.provinceController[next] !== nation) continue;
      // The cost of entering a province is that province's own roads: supply
      // arrives over the ground it is arriving on, not the ground it left.
      const relief =
        effectiveInfrastructure(state, next) * SUPPLY_INFRASTRUCTURE_RELIEF;
      const hop = Math.max(SUPPLY_MIN_HOP_COST, SUPPLY_HOP_COST - relief);
      const through = here + hop;
      if (through >= SUPPLY_RANGE) continue;
      if (through >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, through);
      queue.push(next);
    }
  }

  const reach = new Map<number, number>();
  for (const [province, distance] of cost) {
    reach.set(province, Math.max(0, 1 - distance / SUPPLY_RANGE));
  }
  return reach;
}

/**
 * The share of its demand a nation's sources can actually carry.
 *
 * One figure for the whole nation rather than one per source. Routing demand
 * to particular hubs would need a flow solver, and §6.6 is explicit that
 * supply is never shared between nations precisely so that this stays a single
 * nation's arithmetic. The same reasoning applies inside one.
 */
export function supplyCoverage(state: WorldState, nation: number): number {
  const divisions = state.nations[nation].divisions.length;
  if (divisions === 0) return 1;
  const capacity =
    supplySources(state, nation).length * SUPPLY_SOURCE_THROUGHPUT;
  const demand = divisions * SUPPLY_PER_DIVISION;
  return Math.max(0, Math.min(1, capacity / demand));
}

/** What one division is actually getting, 0..1. Reach times coverage. */
export function supplyOf(
  reach: Map<number, number>,
  coverage: number,
  province: number,
): number {
  return (reach.get(province) ?? 0) * coverage;
}

export const supplySystem: System = {
  name: "supply",

  run(state: WorldState): WorldEvent[] {
    const events: WorldEvent[] = [];

    for (let nation = 1; nation <= state.nationCount; nation++) {
      const divisions = state.nations[nation].divisions;
      if (divisions.length === 0) continue;

      const reach = supplyReach(state, nation);
      const coverage = supplyCoverage(state, nation);

      for (const division of divisions) {
        const supply = supplyOf(reach, coverage, division.province);
        if (supply >= 1) continue;

        // Attrition scales with how short it is, so a division at 90% supply
        // wastes away ten times slower than one at zero. Nothing is destroyed
        // outright and nothing is refused — the number simply got worse.
        const share = SUPPLY_ATTRITION * (1 - supply);
        const delta: [number, number][] = [];
        for (let index = 0; index < division.equipment.length; index++) {
          const held = division.equipment[index];
          if (held <= 0) continue;
          delta.push([index, -Math.min(held, held * share)]);
        }
        if (delta.length === 0) continue;
        events.push({
          kind: "division_equipment_changed",
          nation,
          divisionId: division.id,
          delta,
        });
      }
    }

    return events;
  },
};
