/**
 * Supply over the province graph: how far a nation can fight from its hubs.
 *
 * §6.6, both halves: the land path over the province graph, and — since
 * phase 9 — the sea path between ports, carried by convoys that can be sunk. Two numbers decide what a division gets, and they
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

import { INTERDICTION_MAX } from "src/shared/config/air";
import {
  CONVOY_WEAR,
  CONVOYS_PER_DIVISION_ZONE,
  ESCORT_COVER,
  SEA_RAID_SUPPLY_MAX,
  SEA_SUPPLY_FLOOR,
  SEA_SUPPLY_RANGE,
} from "src/shared/config/naval";
import {
  SUPPLY_ATTRITION,
  SUPPLY_HOP_COST,
  SUPPLY_INFRASTRUCTURE_RELIEF,
  SUPPLY_MIN_HOP_COST,
  SUPPLY_PER_DIVISION,
  SUPPLY_RANGE,
  SUPPLY_SOURCE_THROUGHPUT,
} from "src/shared/config/supply";
import { equipmentIndex } from "src/shared/economy/Equipment";
import { seaPath } from "src/shared/map/SeaGraph";
import type { System } from ".";
import {
  atPeace,
  countBuilding,
  effectiveInfrastructure,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";
import { hostileMissionEffect, missionEffect } from "./zones";

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

export interface SeaSupplyRoute {
  /** The coastal province being supplied over water. */
  province: number;
  /** The sea zones the route passes through, both ends included. */
  path: readonly number[];
  /** Zones crossed — zero when both ports share a sea zone. */
  zones: number;
  /** Convoys the route wants: per division at the far end, per zone. */
  convoysWanted: number;
}

/**
 * The sea routes a nation's supply actually runs, §6.6: from a supply source
 * that is also a port, to a controlled coastal province with a port of its
 * own — "a port on both ends". Only the port province itself is supplied
 * this way; pushing further inland is what building a supply hub on the far
 * shore is for.
 *
 * Exported because the naval system reads the same routes to know where a
 * nation's convoys are exposed to raiding — one answer, computed one way.
 */
export function seaSupplyRoutes(
  state: WorldState,
  nation: number,
): SeaSupplyRoute[] {
  const map = state.map;
  const sources = supplySources(state, nation);
  const sourcePorts = sources.filter(
    (province) =>
      map.provinces[province].seaZone !== null &&
      countBuilding(state, province, "naval_base") > 0,
  );
  if (sourcePorts.length === 0) return [];

  const routes: SeaSupplyRoute[] = [];
  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] !== nation) continue;
    if (sources.includes(province)) continue;
    const it = map.provinces[province];
    if (it.seaZone === null) continue;
    if (countBuilding(state, province, "naval_base") === 0) continue;

    let best: number[] | null = null;
    for (const port of sourcePorts) {
      const path = seaPath(
        map,
        map.provinces[port].seaZone as number,
        it.seaZone,
      );
      if (path === null) continue;
      if (best === null || path.length < best.length) best = path;
    }
    if (best === null) continue;
    const zones = best.length - 1;
    if (zones > SEA_SUPPLY_RANGE) continue;

    const divisions = state.nations[nation].divisions.filter(
      (division) => division.province === province,
    ).length;
    routes.push({
      province,
      path: best,
      zones,
      convoysWanted:
        CONVOYS_PER_DIVISION_ZONE * Math.max(1, zones) * Math.max(1, divisions),
    });
  }
  return routes;
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

  // **Interdiction, §6.7.** Enemy aircraft over a zone cut what gets through
  // to the provinces in it. It scales the finished reach rather than the hop
  // costs, because interdiction is not bad roads — the road is fine and the
  // convoy on it is being strafed — and because scaling here means every
  // consumer of reach gets it without asking: the supply system's attrition,
  // combat's strength term, and the number the player is shown.
  //
  // Capped at `INTERDICTION_MAX`, so a province with a hostile air force
  // overhead is badly supplied and never cut off. Degrade, never block.
  const interdiction = new Map<number, number>();
  const interdictionOver = (zone: number): number => {
    const known = interdiction.get(zone);
    if (known !== undefined) return known;
    const share = hostileMissionEffect(
      state,
      zone,
      nation,
      "interdiction",
      "air",
      (a, b) => atPeace(state, a, b),
    );
    interdiction.set(zone, share);
    return share;
  };

  const reach = new Map<number, number>();
  for (const [province, distance] of cost) {
    const base = Math.max(0, 1 - distance / SUPPLY_RANGE);
    const cut =
      INTERDICTION_MAX *
      interdictionOver(state.map.provinces[province].airZone);
    reach.set(province, base * (1 - cut));
  }

  // **The sea path, §6.6.** A controlled port with no land way home falls
  // back to convoys: reach falls with zones crossed, scales with how much of
  // the wanted convoy tonnage the nation actually holds — floored, because a
  // province with no convoys is badly supplied, not cut off — and is cut,
  // never severed, by raiders over the route the same way land reach is cut
  // by interdiction. The convoys themselves are worn and sunk elsewhere (the
  // supply system's wear, the naval system's raiding): this function stays a
  // pure reading of the state.
  const routes = seaSupplyRoutes(state, nation);
  if (routes.length > 0) {
    const stock =
      state.nations[nation].stockpile[equipmentIndex("convoy")] ?? 0;
    const wanted = routes.reduce((sum, route) => sum + route.convoysWanted, 0);
    const carried =
      SEA_SUPPLY_FLOOR +
      (1 - SEA_SUPPLY_FLOOR) * (wanted <= 0 ? 1 : Math.min(1, stock / wanted));
    for (const route of routes) {
      let raid = 0;
      for (const zone of route.path) {
        raid = Math.max(raid, netRaidOver(state, nation, zone));
      }
      const base = Math.max(0, 1 - route.zones / SEA_SUPPLY_RANGE);
      const cut =
        INTERDICTION_MAX *
        interdictionOver(state.map.provinces[route.province].airZone);
      const sea =
        base * carried * (1 - SEA_RAID_SUPPLY_MAX * raid) * (1 - cut);
      if (sea > (reach.get(route.province) ?? 0)) {
        reach.set(route.province, sea);
      }
    }
  }
  return reach;
}

/**
 * What raiding is worth against this nation's convoys in one zone, 0..1:
 * every hostile raider's effect, less what the nation's own escorts in the
 * same zone cover. §6.8's counter, in the one place convoys are consumed.
 */
export function netRaidOver(
  state: WorldState,
  nation: number,
  zone: number,
): number {
  const raid = hostileMissionEffect(
    state,
    zone,
    nation,
    "convoy_raiding",
    "naval",
    (a, b) => atPeace(state, a, b),
  );
  if (raid <= 0) return 0;
  const escort = missionEffect(state, zone, nation, "convoy_escort", "naval");
  return raid * Math.max(0, 1 - ESCORT_COVER * escort);
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
      // **Sea supply wears the convoys that carry it** (§6.3: consumed by
      // sea supply). Wear, not battle: a small share of what each route
      // wants, every tick it runs, which is what makes convoys a standing
      // production line rather than a one-off purchase. Raiding losses are
      // the naval system's, one system later — the §6 order's deliberate
      // one-tick lag.
      const routes = seaSupplyRoutes(state, nation);
      if (routes.length > 0) {
        const held =
          state.nations[nation].stockpile[equipmentIndex("convoy")] ?? 0;
        if (held > 0) {
          const wanted = routes.reduce(
            (sum, route) => sum + route.convoysWanted,
            0,
          );
          const worn = Math.min(held, CONVOY_WEAR * Math.min(held, wanted));
          if (worn > 0) {
            events.push({
              kind: "stockpile_changed",
              nation,
              delta: [[equipmentIndex("convoy"), -worn]],
            });
          }
        }
      }

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
