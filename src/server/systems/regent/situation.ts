/**
 * What the regent knows before it decides anything, computed once per visit.
 *
 * Every rule in this directory is a pure function of a `Situation`, so what
 * the situation contains is the whole of what the steward can see: its own
 * provinces and borders, its supply, who is over its zones, where its
 * convoys sail, what it makes and what it lacks. Reading it once keeps the
 * rules cheap and — more important — keeps them honest about their inputs.
 */

import { COMBAT_WIDTH } from "src/shared/config/combat";
import {
  CONVOYS_PER_TRADE_FLOW_ZONE,
  SEA_SUPPLY_RANGE,
} from "src/shared/config/naval";
import type { Resource } from "src/shared/config/provinces";
import { RESOURCES } from "src/shared/config/provinces";
import type { RegentFocus } from "src/shared/config/regent";
import { SUPPLY_SOURCE_THROUGHPUT } from "src/shared/config/supply";
import {
  nationIsCoastal,
  temperamentOf,
  type Temperament,
} from "src/shared/config/temperament";
import { AIR_MISSIONS } from "src/shared/economy/Formations";
import { tradeFlowRate } from "src/shared/economy/Trade";
import {
  agreementIsLive,
  assignedFactories,
  atPeace,
  availableFactories,
  countBuilding,
  divisionStrength,
  type AttackOrder,
  type Division,
  type NationState,
  type WorldState,
} from "../../world/WorldState";
import { measureNation, type NationEconomy } from "../economy";
import { tradeRouteBetween } from "../routes";
import {
  seaSupplyRoutes,
  supplyCoverage,
  supplyOf,
  supplyReach,
  supplySources,
  type SeaSupplyRoute,
} from "../supply";
import { hostileMissionEffect } from "../zones";
import { regentBreak } from "./break";

export interface Border {
  /** Hostile provinces next door: not mine, held by somebody I am not at peace with. */
  hostile: number[];
  /** Enemy strength standing next door, plus half a point per empty enemy province. */
  threat: number;
}

export interface Situation {
  state: WorldState;
  tick: number;
  nation: number;
  me: NationState;
  temperament: Temperament;
  focus: RegentFocus;
  /** Provinces I hold, ascending — the deterministic order everything walks. */
  mine: number[];
  /** Of those, the ones I own too: the only ones I may build or recruit in. */
  owned: number[];
  capital: number | null;
  coastal: boolean;
  border: Map<number, Border>;
  reach: Map<number, number>;
  coverage: number;
  sources: number;
  /** Full divisions the supply sources can carry. */
  capacity: number;
  supplyOf: (province: number) => number;
  divisionsAt: Map<number, Division[]>;
  /** A division below `REGENT_STARVING` exists: fill before raising more. */
  starving: boolean;
  /** Hostile air over each zone that holds one of my provinces, 0..1. */
  airThreat: Map<number, number>;
  /** Zones of my provinces. */
  myAirZones: Set<number>;
  /** Zones of my standing attacks' targets and of my threatened borders. */
  frontZones: Set<number>;
  attacks: AttackOrder[];
  sea: {
    routes: SeaSupplyRoute[];
    /** Every zone my convoys cross, supply and trade alike. */
    routeZones: number[];
    convoysWanted: number;
    /** No land border at all: the sea is the only way in or out. */
    island: boolean;
    /** Zones the sea routes of nations I am not at peace with cross. Lazy: costly. */
    enemySeaZones: () => number[];
  };
  economy: NationEconomy;
  scarcest: Resource | null;
  /** Demand the scarcest resource is short by, per tick. */
  shortfall: number;
  factories: {
    military: { total: number; assigned: number };
  };
  bases: { air: number[]; naval: number[] };
}

/** The provinces a nation controls, ascending — the deterministic order. */
function controlled(state: WorldState, nation: number): number[] {
  const mine: number[] = [];
  for (let p = 0; p < state.provinceController.length; p++) {
    if (state.provinceController[p] === nation) mine.push(p);
  }
  return mine;
}

/** The sea zones a nation's convoys cross, supply and sea trade alike. */
function seaZonesOf(
  state: WorldState,
  nation: number,
  routes: SeaSupplyRoute[],
): { zones: number[]; convoysWanted: number } {
  const zones = new Set<number>();
  let convoysWanted = 0;
  for (const route of routes) {
    for (const zone of route.path) zones.add(zone);
    convoysWanted += route.convoysWanted;
  }
  for (const agreement of state.agreements) {
    if (agreement.type !== "trade" || agreement.terms === null) continue;
    if (!agreementIsLive(agreement, state.tick)) continue;
    if (!agreement.parties.includes(nation)) continue;
    const route = tradeRouteBetween(
      state,
      agreement.parties[0],
      agreement.parties[1],
    );
    if (route.kind !== "sea") continue;
    for (const zone of route.path) zones.add(zone);
    // The importer finds the convoys (trade.ts): only my imports want them.
    if (agreement.parties[1] === nation) {
      convoysWanted +=
        CONVOYS_PER_TRADE_FLOW_ZONE *
        tradeFlowRate(agreement.terms) *
        Math.max(1, route.zones);
    }
  }
  return { zones: [...zones].sort((a, b) => a - b), convoysWanted };
}

export function assess(
  state: WorldState,
  nation: number,
  tick: number,
): Situation {
  const me = state.nations[nation];
  const map = state.map;
  const mine = controlled(state, nation);
  const owned = mine.filter((p) => state.provinceOwner[p] === nation);
  const coastal = nationIsCoastal(map, nation);
  const temperament = temperamentOf(state.worldSeed, nation, coastal);
  const capital =
    owned.find((p) => map.provinces[p].capital) ??
    mine.find((p) => map.provinces[p].capital) ??
    null;

  const divisionsAt = new Map<number, Division[]>();
  let starving = false;
  for (const division of me.divisions) {
    if (division.province < 0) continue;
    const list = divisionsAt.get(division.province) ?? [];
    list.push(division);
    divisionsAt.set(division.province, list);
    if (divisionStrength(division) < 0.5) starving = true;
  }

  const border = new Map<number, Border>();
  let landNeighbour = false;
  for (const p of mine) {
    let hostile: number[] = [];
    let threat = 0;
    for (const next of map.provinces[p].neighbours) {
      const holder = state.provinceController[next];
      if (holder === nation) continue;
      landNeighbour = true;
      if (holder <= 0 || atPeace(state, nation, holder)) continue;
      hostile.push(next);
      const standing = state.nations[holder].divisions
        .filter((d) => d.province === next)
        .reduce((sum, d) => sum + divisionStrength(d), 0);
      threat += standing > 0 ? standing : 0.5;
    }
    hostile = hostile.sort((a, b) => a - b);
    if (hostile.length > 0) border.set(p, { hostile, threat });
  }

  const reach = supplyReach(state, nation);
  const coverage = supplyCoverage(state, nation);
  const sources = supplySources(state, nation).length;

  const myAirZones = new Set<number>();
  for (const p of mine) myAirZones.add(map.provinces[p].airZone);
  const airThreat = new Map<number, number>();
  const peace = (a: number, b: number): boolean => atPeace(state, a, b);
  // A blind steward (break.ts) sees an empty sky: the gate's counter-proof.
  const sky = regentBreak() === "blind" ? [] : [...myAirZones];
  for (const zone of sky.sort((a, b) => a - b)) {
    let worst = 0;
    for (const mission of AIR_MISSIONS) {
      worst = Math.max(
        worst,
        hostileMissionEffect(state, zone, nation, mission, "air", peace),
      );
    }
    if (worst > 0) airThreat.set(zone, worst);
  }
  const frontZones = new Set<number>();
  for (const attack of me.attacks) {
    frontZones.add(map.provinces[attack.province].airZone);
  }
  for (const [p, b] of border) {
    if (b.threat > 0.5) frontZones.add(map.provinces[p].airZone);
  }

  const routes = coastal ? seaSupplyRoutes(state, nation) : [];
  const seaUse = seaZonesOf(state, nation, routes);
  let enemyZones: number[] | null = null;
  const enemySeaZones = (): number[] => {
    if (enemyZones !== null) return enemyZones;
    const zones = new Set<number>();
    for (let other = 1; other <= state.nationCount; other++) {
      if (other === nation || atPeace(state, nation, other)) continue;
      if (!nationIsCoastal(map, other)) continue;
      const theirs = seaZonesOf(state, other, seaSupplyRoutes(state, other));
      for (const zone of theirs.zones) zones.add(zone);
    }
    enemyZones = [...zones].sort((a, b) => a - b);
    return enemyZones;
  };

  const economy = measureNation(state, nation);
  let scarcest: Resource | null = null;
  let worstCover = Infinity;
  let shortfall = 0;
  for (const resource of RESOURCES) {
    const demand = economy.demand[resource];
    if (demand <= 0) continue;
    const cover =
      (me.resources[resource] + economy.extraction[resource]) / demand;
    if (cover < worstCover) {
      worstCover = cover;
      scarcest = resource;
      shortfall = Math.max(0, demand - economy.extraction[resource]);
    }
  }

  const bases = { air: [] as number[], naval: [] as number[] };
  for (const p of owned) {
    if (countBuilding(state, p, "air_base") > 0) bases.air.push(p);
    if (countBuilding(state, p, "naval_base") > 0) bases.naval.push(p);
  }

  return {
    state,
    tick,
    nation,
    me,
    temperament,
    focus: me.regent.focus,
    mine,
    owned,
    capital,
    coastal,
    border,
    reach,
    coverage,
    sources,
    capacity: sources * SUPPLY_SOURCE_THROUGHPUT,
    supplyOf: (p) => supplyOf(reach, coverage, p),
    divisionsAt,
    starving,
    airThreat,
    myAirZones,
    frontZones,
    attacks: me.attacks,
    sea: {
      routes,
      routeZones: seaUse.zones,
      convoysWanted: seaUse.convoysWanted,
      island: coastal && !landNeighbour,
      enemySeaZones,
    },
    economy,
    scarcest,
    shortfall,
    factories: {
      military: {
        total: availableFactories(state, nation, "military_factory"),
        assigned: assignedFactories(state, nation, "military_factory"),
      },
    },
    bases,
  };
}

/** How many divisions may stand in one province and still all fight. */
export const STACK = COMBAT_WIDTH;

/** Whether a nation's sea supply is even possible at this range. */
export const SEA_RANGE = SEA_SUPPLY_RANGE;
