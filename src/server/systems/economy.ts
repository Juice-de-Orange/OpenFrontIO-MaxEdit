/**
 * Extraction, consumption, and what a shortage does.
 *
 * This is where invariant 2 lives — *everything degrades, never hard-blocks*.
 * A nation short of steel does not lose its factories and is not refused
 * anything; every factory that needs steel runs at the fraction of its demand
 * the nation could actually cover, and the economy screen shows that fraction.
 * It is the single most important consistency rule in the game, because it is
 * what makes the whole thing readable: a player is never confronted with a
 * wall, only with a number that got worse.
 *
 * One sufficiency figure per nation, taken as the *worst* of the per-resource
 * ratios, rather than one per resource. A factory needs all of its inputs, so
 * scaling each input by its own ratio would let a nation with plenty of
 * aluminium and no steel keep producing at the aluminium rate — which is a
 * factory running on nothing. It also gives the UI one number to explain
 * rather than four.
 */

import type { Resource } from "src/shared/config/provinces";
import { RESOURCES } from "src/shared/config/provinces";
import {
  CIVILIAN_FACTORY_OUTPUT,
  DOCKYARD_DEMAND,
  DOCKYARD_OUTPUT,
  EXTRACTION_PER_DEPOSIT,
  EXTRACTION_UPGRADE_BONUS,
  INFRASTRUCTURE_EXTRACTION_BONUS,
  MANPOWER_REGROWTH,
  MILITARY_FACTORY_DEMAND,
  MILITARY_FACTORY_OUTPUT,
  OCCUPIED_OUTPUT_FACTOR,
} from "src/shared/config/rates";
import { SYNTHETIC } from "src/shared/economy/Buildings";
import type { System } from ".";
import {
  countBuilding,
  effectiveInfrastructure,
  manpowerCap,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";

/** What a nation's economy is doing this tick. Pure; nothing is stored. */
export interface NationEconomy {
  /** Resources mined this tick, before anything is spent. */
  extraction: Record<Resource, number>;
  /** What the factories asked for. */
  demand: Record<Resource, number>;
  /** 0..1 — the share of `demand` the nation could cover. */
  sufficiency: number;
  /** Construction points per tick. Independent of resources, by design. */
  construction: number;
  /** Industrial output per tick, already scaled by `sufficiency`. */
  industry: number;
}

function zeroed(): Record<Resource, number> {
  return { steel: 0, oil: 0, aluminium: 0, rubber: 0 };
}

/**
 * Everything one nation's economy produces and consumes this tick.
 *
 * Called twice a tick — once here, once by the construction system — and by
 * the socket when a client connects. It has to be pure and it has to be
 * cheap; it is a scan of the nation's own provinces.
 *
 * **Construction points do not depend on resources.** Civilian factories draw
 * nothing (§5 lists military factories, dockyards and units as the consumers),
 * so this figure is the same before and after the economy system has spent
 * anything. That is what lets the construction system recompute it rather than
 * having it handed down, and it removes the one place the two could disagree.
 */
export function measureNation(
  state: WorldState,
  nation: number,
): NationEconomy {
  const extraction = zeroed();
  const demand = zeroed();
  let construction = 0;
  let industry = 0;

  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] !== nation) continue;

    // Holding ground is not the same as owning it: an occupied province
    // yields a fraction until the ownership transfers (decision 0002, and
    // OCCUPIED_OUTPUT_FACTOR answers CLAUDE.md §10's open question).
    const occupied = state.provinceOwner[province] !== nation;
    const factor = occupied ? OCCUPIED_OUTPUT_FACTOR : 1;

    const deposits = state.map.provinces[province].resourceDeposits;
    const infrastructure = effectiveInfrastructure(state, province);
    const upgrades = countBuilding(state, province, "extraction_upgrade");
    const yieldFactor =
      factor *
      (1 + infrastructure * INFRASTRUCTURE_EXTRACTION_BONUS) *
      (1 + upgrades * EXTRACTION_UPGRADE_BONUS);
    for (const resource of RESOURCES) {
      const deposit = deposits[resource];
      if (deposit === undefined) continue;
      extraction[resource] += deposit * EXTRACTION_PER_DEPOSIT * yieldFactor;
    }

    construction +=
      countBuilding(state, province, "civilian_factory") *
      CIVILIAN_FACTORY_OUTPUT *
      factor;

    const military = countBuilding(state, province, "military_factory");
    const dockyards = countBuilding(state, province, "dockyard");
    industry +=
      (military * MILITARY_FACTORY_OUTPUT + dockyards * DOCKYARD_OUTPUT) *
      factor;
    addDemand(demand, MILITARY_FACTORY_DEMAND, military);
    addDemand(demand, DOCKYARD_DEMAND, dockyards);

    for (const kind of ["synthetic_oil", "synthetic_rubber"] as const) {
      const count = countBuilding(state, province, kind);
      if (count === 0) continue;
      const recipe = SYNTHETIC[kind];
      demand[recipe.from] += recipe.fromRate * count;
    }
  }

  const stock = state.nations[nation].resources;
  let sufficiency = 1;
  for (const resource of RESOURCES) {
    if (demand[resource] <= 0) continue;
    const available = stock[resource] + extraction[resource];
    sufficiency = Math.min(sufficiency, available / demand[resource]);
  }
  // Only ever scaled down. A nation with more than it needs does not get a
  // bonus for it; that is what a stockpile is for.
  sufficiency = Math.max(0, Math.min(1, sufficiency));

  return {
    extraction,
    demand,
    sufficiency,
    construction,
    industry: industry * sufficiency,
  };
}

function addDemand(
  into: Record<Resource, number>,
  recipe: Partial<Record<Resource, number>>,
  count: number,
): void {
  if (count === 0) return;
  for (const resource of RESOURCES) {
    const rate = recipe[resource];
    if (rate !== undefined) into[resource] += rate * count;
  }
}

/** What the synthetic refineries turn steel into, at this sufficiency. */
function syntheticOutput(
  state: WorldState,
  nation: number,
  sufficiency: number,
): Partial<Record<Resource, number>> {
  const produced: Partial<Record<Resource, number>> = {};
  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] !== nation) continue;
    for (const kind of ["synthetic_oil", "synthetic_rubber"] as const) {
      const count = countBuilding(state, province, kind);
      if (count === 0) continue;
      const recipe = SYNTHETIC[kind];
      produced[recipe.to] =
        (produced[recipe.to] ?? 0) + recipe.toRate * count * sufficiency;
    }
  }
  return produced;
}

export const economySystem: System = {
  name: "economy",

  run(state: WorldState): WorldEvent[] {
    const events: WorldEvent[] = [];
    for (let nation = 1; nation <= state.nationCount; nation++) {
      const economy = measureNation(state, nation);

      const delta: Partial<Record<Resource, number>> = {};
      let moved = false;
      for (const resource of RESOURCES) {
        const change =
          economy.extraction[resource] -
          economy.demand[resource] * economy.sufficiency;
        if (change === 0) continue;
        delta[resource] = change;
        moved = true;
      }
      for (const [resource, amount] of Object.entries(
        syntheticOutput(state, nation, economy.sufficiency),
      )) {
        delta[resource as Resource] =
          (delta[resource as Resource] ?? 0) + amount;
        moved = true;
      }

      if (moved) events.push({ kind: "resources_changed", nation, delta });

      // Manpower regrows toward what the nation's land can support, at a
      // rate like everything else (invariant 1). Losing land lowers the
      // ceiling and the pool is cut to it in the same tick — the men were in
      // the province that changed hands, and there is nowhere for them to
      // walk to. Growth is the slow direction; loss is not.
      const cap = manpowerCap(state, nation);
      const held = state.nations[nation].manpower;
      if (held < cap) {
        events.push({
          kind: "manpower_changed",
          nation,
          delta: Math.min(cap - held, cap * MANPOWER_REGROWTH),
        });
      } else if (held > cap) {
        events.push({ kind: "manpower_changed", nation, delta: cap - held });
      }
    }
    return events;
  },
};
