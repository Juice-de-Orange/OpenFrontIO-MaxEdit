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

import type { AgreementType } from "src/shared/config/diplomacy";
import {
  AGREEMENT_NOTICE_TICKS,
  PEACE_AGREEMENTS,
  TRUST_MAX,
  TRUST_MIN,
  TRUST_START,
} from "src/shared/config/diplomacy";
import type { Resource } from "src/shared/config/provinces";
import { RESOURCES } from "src/shared/config/provinces";
import {
  DOCKYARD_OUTPUT,
  EFFICIENCY_CAP,
  EFFICIENCY_FLOOR,
  EQUIPMENT_CAP,
  MANPOWER_PER_TILE,
  MILITARY_FACTORY_OUTPUT,
  RESOURCE_CAP,
} from "src/shared/config/rates";
import {
  MAX_RESEARCH_SLOTS,
  modifiersOf,
  type Modifiers,
  type TechId,
} from "src/shared/config/techs";
import {
  BUILDING_TYPES,
  buildingIndex,
  BUILDINGS,
  type BuildingType,
} from "src/shared/economy/Buildings";
import {
  DIVISION_TEMPLATE,
  EQUIPMENT,
  EQUIPMENT_TYPES,
  equipmentIndex,
  type EquipmentType,
  type Yard,
} from "src/shared/economy/Equipment";
import {
  FORMATIONS,
  type FormationTemplate,
  type Mission,
} from "src/shared/economy/Formations";
import type { ZoneId } from "src/shared/map/Province";
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

/**
 * One production line: a set of factories all making the same thing.
 *
 * §6.2. Output is `factories × base rate × efficiency`, and the efficiency is
 * the whole mechanic — it climbs slowly while the line runs and is knocked
 * back to the floor the moment the equipment type changes.
 */
export interface ProductionLine {
  id: number;
  equipment: EquipmentType;
  /** How many of the nation's factories are on it. Never more than it has. */
  factories: number;
  /** EFFICIENCY_FLOOR..EFFICIENCY_CAP. */
  efficiency: number;
}

/**
 * A division: men in a province, holding some fraction of what it should.
 *
 * No template, by design (§10 excludes division designers). Every division
 * wants the same `DIVISION_TEMPLATE`, and the only thing that varies is how
 * much of it there actually is — which is what makes a drained stockpile
 * something a player feels rather than reads.
 */
export interface Division {
  id: number;
  province: number;
  /** Held equipment, indexed by `equipmentIndex`. */
  equipment: number[];
}

/**
 * A wing or a fleet: what a player puts in a zone.
 *
 * §6.7 and §6.8 are one system with two mission sets, so this is one entity
 * with a template that says which (`shared/economy/Formations.ts`). A
 * formation is raised at a base, assigned to a zone with a mission, and left
 * there — invariant 4: the player allocates, never micromanages.
 *
 * `zone` and `mission` are null together or set together. A formation with
 * neither is on the ground: it costs nothing, contributes nothing, and loses
 * nothing.
 */
export interface Formation {
  id: number;
  template: FormationTemplate;
  /** The province whose air or naval base it flies out of. */
  base: number;
  /** The zone it is assigned to, or null when it is standing down. */
  zone: ZoneId | null;
  mission: Mission | null;
  /** Held equipment, indexed by `equipmentIndex`. */
  equipment: number[];
}

/**
 * One research slot: what it is working on, and how far in.
 *
 * `MAX_RESEARCH_SLOTS` of these always exist, whether or not the nation has
 * unlocked them. A fixed-length array keeps the snapshot's shape stable when a
 * tech grants a slot, and `slotsFor` is what decides which of them a nation
 * may actually use — the state does not change shape, only the rule does.
 */
export interface ResearchSlot {
  tech: TechId | null;
  /** Ticks of work done, against the tech's own duration. */
  progress: number;
}

/** What a standing trade agreement moves every tick, in both directions. */
export interface TradeTerms {
  /** The resource the first party sends. */
  resource: Resource;
  resourcePerTick: number;
  /** Construction points the second party sends back (§6.5: no second currency). */
  pointsPerTick: number;
}

/**
 * A bilateral agreement, and everything about it.
 *
 * **Indefinite** (invariant 3). There is no end tick in here and nothing that
 * counts down to one. `noticeAt` is the tick somebody gave notice, and the
 * agreement dissolves `AGREEMENT_NOTICE_TICKS` after that — which is a
 * consequence of a decision somebody made, not of time passing.
 *
 * On the world rather than on a nation, because it belongs to neither of them.
 * A copy per side would be two records that can disagree, and the one that
 * disagreed would be the one a restore brought back.
 */
export interface Agreement {
  id: number;
  type: AgreementType;
  /**
   * Both nations, proposer first.
   *
   * For a trade agreement the order *is* half the terms: the first party
   * sends the resource, the second sends the construction points back.
   */
  parties: [number, number];
  terms: TradeTerms | null;
  /** False while this is still a proposal nobody has answered. */
  accepted: boolean;
  /** The tick notice was given, or null while the agreement stands. */
  noticeAt: number | null;
  /** Who gave that notice. Kept for the record; the cost is already paid. */
  noticeBy: number | null;
}

/**
 * A standing order to take a province, and the tick it was given.
 *
 * §6.9 is front-based: an attack is not an event, it is a *posture*. The order
 * stands until the province is taken, until the player withdraws it, or until
 * the province becomes theirs some other way — and every tick in between is a
 * tick of fighting that costs both sides equipment.
 */
export interface AttackOrder {
  province: number;
  since: number;
  /**
   * How far the front has ground into the province, 0..1.
   *
   * Invariant 1: taking a province is a rate, never a lump sum. Each tick the
   * strength comparison moves this by a little — forward when the attacker is
   * ahead, back when behind — and control changes only when it completes. It
   * lives on the order so calling the attack off loses it: an order withdrawn
   * and re-given starts at zero, and there is no way to bank a front.
   */
  progress: number;
}

/** A division's province while it is at sea (§6.8: visible, vulnerable). */
export const AT_SEA = -1;

/**
 * A division on the water, ordered from one coast to another (§6.8).
 *
 * The transit is the visible half of an invasion: it takes
 * `INVASION_TICKS_PER_ZONE` a zone, the world tells everyone it is coming,
 * and a defender who is watching has that long to put a garrison on the
 * beach — which turns the landing back.
 */
export interface SeaTransit {
  id: number;
  divisionId: number;
  /** The coastal province it embarked from. */
  from: number;
  /** The hostile coastal province it means to land on. */
  to: number;
  /** The sea zones the crossing passes through, both ends included. */
  path: number[];
  ticksLeft: number;
}

export interface NationState {
  resources: Record<Resource, number>;
  constructionQueue: ConstructionOrder[];
  /** Equipment held, indexed by `equipmentIndex`. Units draw from this. */
  stockpile: number[];
  /** Men available to raise divisions with. Regrows toward a cap from land. */
  manpower: number;
  productionLines: ProductionLine[];
  divisions: Division[];
  /** Wings and fleets. §6.7 and §6.8 share the list, as they share the code. */
  formations: Formation[];
  /**
   * The id the next order will get. Monotonic, never reused.
   *
   * In the snapshot and in the state hash, because a restore that handed out
   * an id twice would give a nation two orders a cancellation cannot tell
   * apart.
   */
  nextOrderId: number;
  /** The same, for production lines, divisions, formations and transits. */
  nextLineId: number;
  nextDivisionId: number;
  nextFormationId: number;
  nextTransitId: number;
  /** Divisions at sea (§6.8). The division's own `province` reads AT_SEA. */
  seaTransits: SeaTransit[];
  researchSlots: ResearchSlot[];
  /** Finished techs, in the order they finished. Order is not significant. */
  unlockedTechs: TechId[];
  /**
   * How much anyone should believe this nation's word, 0..100. Public (§7).
   *
   * Spent by cancelling agreements and never earned back, so a serial
   * betrayer ends up diplomatically isolated without any rule forbidding
   * betrayal (§6.5).
   */
  trust: number;
  /**
   * The last tick anything was heard from this nation's player.
   *
   * Set by every accepted command, including the `nation_present` one a
   * session sends when it connects — so "somebody is playing this nation" is
   * a fact the command log records and a replay can reconstruct (§4). The
   * dead-partner rule reads it and nothing else does.
   */
  lastSeenTick: number;
  /**
   * Standing orders with the world market, per resource, per tick.
   *
   * Positive buys and costs construction points; negative sells and earns
   * them, at a much worse rate. Always available and needing no diplomacy,
   * which is what keeps an isolated nation playable (§6.5).
   */
  market: Record<Resource, number>;
  /** Provinces this nation is attacking, in the order the attacks were given. */
  attacks: AttackOrder[];
}

export interface WorldState {
  tick: number;
  readonly map: ProvinceMap;

  /**
   * The world's own seed, for everything §9 wants derived from
   * `(worldSeed, tick, contextId)`.
   *
   * Not the map's hashes, which were the obvious alternative and are already in
   * the state: two seasons on Europe would then roll identically, tick for
   * tick, and a season is six weeks long enough for somebody to notice. Set
   * once when the world is created, never changed, in the snapshot and in the
   * hash like everything else.
   */
  worldSeed: number;

  /**
   * Every proposal and every standing agreement in the world.
   *
   * One list, not one per nation, for the reason on `Agreement` itself.
   */
  agreements: Agreement[];
  /**
   * The id the next agreement will get. Monotonic, never reused.
   *
   * On the world for the same reason the list is, and in the hash for the
   * same reason `nextOrderId` is: a restore that handed out an id twice would
   * give two nations two agreements a cancellation cannot tell apart.
   */
  nextAgreementId: number;
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

/**
 * How much of what it should have, as a fraction.
 *
 * The *worst* ratio across the template, not the average. §6.3 scales a
 * unit's strength linearly with its equipment, and a division with all its
 * rifles and no artillery is not four fifths of a division — it is a division
 * that cannot do one of the two things it exists to do. Same reasoning as the
 * economy's sufficiency, and the same number vocabulary for a player to read.
 */
export function divisionStrength(division: Division): number {
  let worst = 1;
  for (const [type, wanted] of Object.entries(DIVISION_TEMPLATE)) {
    if (wanted === undefined || wanted <= 0) continue;
    const held = division.equipment[equipmentIndex(type as EquipmentType)] ?? 0;
    worst = Math.min(worst, held / wanted);
  }
  return Math.max(0, Math.min(1, worst));
}

/**
 * The same, for a wing or a fleet, against its own template.
 *
 * Deliberately the same rule and the same worst-ratio reasoning as a division,
 * so a player reads one number vocabulary across the whole military
 * (invariant 9). A wing at half strength is half a wing in its zone.
 */
export function formationStrength(formation: Formation): number {
  let worst = 1;
  for (const [type, wanted] of Object.entries(
    FORMATIONS[formation.template].equipment,
  )) {
    if (wanted === undefined || wanted <= 0) continue;
    const held =
      formation.equipment[equipmentIndex(type as EquipmentType)] ?? 0;
    worst = Math.min(worst, held / wanted);
  }
  return Math.max(0, Math.min(1, worst));
}

/**
 * The manpower this nation can eventually hold.
 *
 * From land it both owns and holds. Occupied territory conscripts for nobody:
 * not for the occupier, who has no claim on the people there, and not for the
 * owner, who is not in the room. See docs/decisions/0008.
 */
export function manpowerCap(state: WorldState, nation: number): number {
  let cap = 0;
  for (let province = 0; province < state.provinceOwner.length; province++) {
    if (state.provinceOwner[province] !== nation) continue;
    if (state.provinceController[province] !== nation) continue;
    cap += state.map.provinces[province].tileCount * MANPOWER_PER_TILE;
  }
  return cap;
}

/** Factories of this kind in provinces the nation holds. */
export function availableFactories(
  state: WorldState,
  nation: number,
  yard: Yard,
): number {
  let total = 0;
  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] !== nation) continue;
    total += countBuilding(state, province, yard);
  }
  return total;
}

/**
 * What this nation's research has done to the base rates.
 *
 * Read here rather than cached on the nation: a cached fold is a second source
 * of truth that every restore has to keep in step with the first, and the fold
 * is a handful of additions over a list that is never longer than the tech
 * tree. Every system that reads a rate reads it through one of the three
 * helpers below, so a tech takes effect everywhere or nowhere.
 */
export function nationModifiers(state: WorldState, nation: number): Modifiers {
  return modifiersOf(state.nations[nation].unlockedTechs);
}

/** What one factory of this kind turns out per tick, research included. */
export function factoryOutput(
  state: WorldState,
  nation: number,
  yard: Yard,
): number {
  const base = yard === "dockyard" ? DOCKYARD_OUTPUT : MILITARY_FACTORY_OUTPUT;
  return base * (1 + nationModifiers(state, nation).factoryOutput);
}

/**
 * How high this nation's production lines may climb.
 *
 * The cap, not the floor: research makes a committed line better, never a
 * fresh one. That is the same lesson §6.2 is built around, from the other
 * side — the reward is for the line that has been running, not for having
 * looked something up.
 */
export function efficiencyCapFor(state: WorldState, nation: number): number {
  return EFFICIENCY_CAP + nationModifiers(state, nation).efficiencyCap;
}

/** Factories of this kind already committed to a production line. */
export function assignedFactories(
  state: WorldState,
  nation: number,
  yard: Yard,
  ignoreLineId = -1,
): number {
  let total = 0;
  for (const line of state.nations[nation].productionLines) {
    if (line.id === ignoreLineId) continue;
    if (EQUIPMENT[line.equipment].yard !== yard) continue;
    total += line.factories;
  }
  return total;
}

/** Every agreement this nation is a party to, proposals included. */
export function agreementsOf(state: WorldState, nation: number): Agreement[] {
  return state.agreements.filter(
    (agreement) =>
      agreement.parties[0] === nation || agreement.parties[1] === nation,
  );
}

/** The other side of an agreement, seen from one of them. */
export function otherParty(agreement: Agreement, nation: number): number {
  return agreement.parties[0] === nation
    ? agreement.parties[1]
    : agreement.parties[0];
}

/**
 * Whether an agreement is still moving anything this tick.
 *
 * Accepted, and either nobody has given notice or the notice has not run out
 * yet. A cancelled agreement keeps working for exactly one in-game day and
 * then stops — the flow does not taper, because a rate that quietly halves is
 * harder to plan around than one that stops on a day both sides know.
 */
export function agreementIsLive(agreement: Agreement, tick: number): boolean {
  if (!agreement.accepted) return false;
  if (agreement.noticeAt === null) return true;
  return tick < agreement.noticeAt + AGREEMENT_NOTICE_TICKS;
}

/** A live agreement of this type between these two, if there is one. */
export function agreementBetween(
  state: WorldState,
  a: number,
  b: number,
  type: AgreementType,
): Agreement | undefined {
  return state.agreements.find(
    (agreement) =>
      agreement.type === type &&
      agreementIsLive(agreement, state.tick) &&
      ((agreement.parties[0] === a && agreement.parties[1] === b) ||
        (agreement.parties[0] === b && agreement.parties[1] === a)),
  );
}

/**
 * Whether one nation has promised not to attack the other.
 *
 * §6.9: an attack order against a nation you hold a non-aggression pact or an
 * alliance with is refused at command validation. Breaking the promise first
 * is a separate, deliberate act with its own cost, and it takes a day to take
 * effect — so aggression is announced before it arrives, which is the whole
 * of what invariant 3 buys.
 */
export function atPeace(state: WorldState, a: number, b: number): boolean {
  return PEACE_AGREEMENTS.some(
    (type) => agreementBetween(state, a, b, type) !== undefined,
  );
}

/** A fresh world: every province with its starting owner, capitals equipped. */
export function createWorldState(
  map: ProvinceMap,
  nationCount: number,
  starting: {
    capitalBuildings: Readonly<Record<string, number>>;
    resources: Record<Resource, number>;
    /** The world's seed. Defaulted only so a test fixture need not care. */
    worldSeed?: number;
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
    agreements: [],
    nextAgreementId: 1,
    worldSeed: starting.worldSeed ?? 0,
    nations: [],
  };

  // Slot 0 exists so a nation id indexes the array directly. It is never read.
  for (let nation = 0; nation <= nationCount; nation++) {
    state.nations.push({
      resources: { ...starting.resources },
      constructionQueue: [],
      stockpile: new Array<number>(EQUIPMENT_TYPES.length).fill(0),
      manpower: 0,
      productionLines: [],
      divisions: [],
      formations: [],
      nextOrderId: 1,
      nextLineId: 1,
      nextDivisionId: 1,
      nextFormationId: 1,
      // Every slot exists from tick 0; `slotsFor` decides how many of them a
      // nation may use. Growing the array when a tech lands would change the
      // snapshot's shape mid-season for no gain.
      researchSlots: Array.from({ length: MAX_RESEARCH_SLOTS }, () => ({
        tech: null,
        progress: 0,
      })),
      unlockedTechs: [],
      trust: TRUST_START,
      // Nobody has been heard from on tick 0, and nobody has an agreement
      // either, so the dead-partner rule has nothing to act on until both
      // have spoken.
      lastSeenTick: 0,
      market: Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<
        Resource,
        number
      >,
      attacks: [],
      seaTransits: [],
      nextTransitId: 1,
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
    }
  | {
      kind: "production_line_created";
      nation: number;
      /** Without its id: the reducer assigns one, so a replay assigns the same. */
      equipment: EquipmentType;
    }
  | { kind: "production_line_removed"; nation: number; lineId: number }
  | {
      kind: "production_line_switched";
      nation: number;
      lineId: number;
      equipment: EquipmentType;
    }
  | {
      kind: "production_factories_assigned";
      nation: number;
      lineId: number;
      factories: number;
    }
  | {
      kind: "production_efficiency_changed";
      nation: number;
      lineId: number;
      efficiency: number;
    }
  | {
      kind: "stockpile_changed";
      nation: number;
      /** [equipmentIndex, signed amount]. Clamped to [0, EQUIPMENT_CAP]. */
      delta: [number, number][];
    }
  | { kind: "manpower_changed"; nation: number; delta: number }
  | { kind: "research_started"; nation: number; slot: number; tech: TechId }
  | { kind: "research_progressed"; nation: number; slot: number; delta: number }
  | { kind: "research_completed"; nation: number; slot: number; tech: TechId }
  | { kind: "research_cancelled"; nation: number; slot: number }
  | { kind: "division_raised"; nation: number; province: number }
  | { kind: "division_disbanded"; nation: number; divisionId: number }
  | {
      kind: "division_equipment_changed";
      nation: number;
      divisionId: number;
      /** [equipmentIndex, signed amount]. Reinforcement and losses alike. */
      delta: [number, number][];
    }
  | {
      kind: "formation_raised";
      nation: number;
      template: FormationTemplate;
      base: number;
    }
  | { kind: "formation_disbanded"; nation: number; formationId: number }
  | {
      kind: "formation_assigned";
      nation: number;
      formationId: number;
      /** Both null together: the formation stands down at its base. */
      zone: ZoneId | null;
      mission: Mission | null;
    }
  | {
      kind: "formation_equipment_changed";
      nation: number;
      formationId: number;
      /** [equipmentIndex, signed amount]. Reinforcement and losses alike. */
      delta: [number, number][];
    }
  | {
      kind: "agreement_proposed";
      /** The proposer, and the first party of the agreement. */
      nation: number;
      other: number;
      type: AgreementType;
      /** Without an id: the reducer assigns one, so a replay assigns the same. */
      terms: TradeTerms | null;
    }
  | { kind: "agreement_accepted"; agreementId: number }
  /** Declined by the other side, or withdrawn by the proposer. Costs nothing. */
  | { kind: "agreement_withdrawn"; agreementId: number }
  | { kind: "agreement_notice_given"; agreementId: number; nation: number }
  /** The notice ran out, or the dead-partner rule took it. */
  | { kind: "agreement_dissolved"; agreementId: number }
  | { kind: "trust_changed"; nation: number; delta: number }
  /** Something was heard from this nation's player. */
  | { kind: "nation_seen"; nation: number }
  | {
      kind: "market_order_set";
      nation: number;
      resource: Resource;
      /** Positive buys, negative sells, zero clears the order. */
      perTick: number;
    }
  /**
   * An invasion put to sea. The reducer assigns the id, exactly as it does
   * for divisions, so a replay hands out the same ones.
   */
  | {
      kind: "invasion_started";
      nation: number;
      divisionId: number;
      from: number;
      to: number;
      path: number[];
      ticks: number;
    }
  | { kind: "invasion_progressed"; nation: number; id: number }
  /** `landed` false means the beach was garrisoned and the landing turned back. */
  | { kind: "invasion_landed"; nation: number; id: number; landed: boolean }
  | { kind: "attack_ordered"; nation: number; province: number }
  /** The front moved. `progress` is the new absolute value, clamped to 0..1. */
  | {
      kind: "attack_progressed";
      nation: number;
      province: number;
      progress: number;
    }
  /** Withdrawn, or spent: the province is theirs and the order has nothing left. */
  | { kind: "attack_ended"; nation: number; province: number };

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

    case "production_line_created": {
      const nation = state.nations[event.nation];
      nation.productionLines.push({
        id: nation.nextLineId++,
        equipment: event.equipment,
        factories: 0,
        // Every line starts at the floor. There is no way to buy your way
        // past it — that is the point of §6.2.
        efficiency: EFFICIENCY_FLOOR,
      });
      return;
    }

    case "production_line_removed": {
      const lines = state.nations[event.nation].productionLines;
      const at = lines.findIndex((line) => line.id === event.lineId);
      if (at >= 0) lines.splice(at, 1);
      return;
    }

    case "production_line_switched": {
      const line = state.nations[event.nation].productionLines.find(
        (candidate) => candidate.id === event.lineId,
      );
      if (line === undefined) return;
      if (line.equipment === event.equipment) return;
      line.equipment = event.equipment;
      // **The reset.** Switching what a line makes throws away everything it
      // learned making the last thing (§6.2), and it is the reason the regent
      // may never touch an existing line (§6.10).
      line.efficiency = EFFICIENCY_FLOOR;
      return;
    }

    case "production_factories_assigned": {
      const line = state.nations[event.nation].productionLines.find(
        (candidate) => candidate.id === event.lineId,
      );
      // Deliberately does *not* touch efficiency. Adding or removing
      // factories is how a player reallocates industry; only a change of
      // equipment type costs them the ramp.
      if (line !== undefined) line.factories = Math.max(0, event.factories);
      return;
    }

    case "production_efficiency_changed": {
      const line = state.nations[event.nation].productionLines.find(
        (candidate) => candidate.id === event.lineId,
      );
      if (line === undefined) return;
      // Clamped against *this nation's* cap, not the constant. A tech that
      // raises the cap is worth nothing if the reducer still trims to the
      // base one, and the failure would look like the tech doing nothing.
      line.efficiency = Math.max(
        EFFICIENCY_FLOOR,
        Math.min(efficiencyCapFor(state, event.nation), event.efficiency),
      );
      return;
    }

    case "stockpile_changed": {
      const stockpile = state.nations[event.nation].stockpile;
      for (const [index, amount] of event.delta) {
        stockpile[index] = Math.max(
          0,
          Math.min(EQUIPMENT_CAP, stockpile[index] + amount),
        );
      }
      return;
    }

    case "manpower_changed": {
      const nation = state.nations[event.nation];
      nation.manpower = Math.max(0, nation.manpower + event.delta);
      return;
    }

    case "research_started": {
      const slot = state.nations[event.nation].researchSlots[event.slot];
      if (slot === undefined) return;
      slot.tech = event.tech;
      slot.progress = 0;
      return;
    }

    case "research_progressed": {
      const slot = state.nations[event.nation].researchSlots[event.slot];
      if (slot === undefined) return;
      slot.progress += event.delta;
      return;
    }

    case "research_completed": {
      const nation = state.nations[event.nation];
      const slot = nation.researchSlots[event.slot];
      if (slot === undefined) return;
      // Idempotent on the tech: a replay must not be able to unlock the same
      // thing twice and double its modifier.
      if (!nation.unlockedTechs.includes(event.tech)) {
        nation.unlockedTechs.push(event.tech);
      }
      slot.tech = null;
      slot.progress = 0;
      return;
    }

    case "research_cancelled": {
      const slot = state.nations[event.nation].researchSlots[event.slot];
      if (slot === undefined) return;
      // The work is lost, like a cancelled construction order. Changing your
      // mind is the one thing in this game that costs progress.
      slot.tech = null;
      slot.progress = 0;
      return;
    }

    case "division_raised": {
      const nation = state.nations[event.nation];
      nation.divisions.push({
        id: nation.nextDivisionId++,
        province: event.province,
        // Raised empty. It draws from the stockpile over the following ticks,
        // so a nation that raises more divisions than it can equip simply has
        // weaker ones — degrade, never block (invariant 2).
        equipment: new Array<number>(EQUIPMENT_TYPES.length).fill(0),
      });
      return;
    }

    case "division_disbanded": {
      const divisions = state.nations[event.nation].divisions;
      const at = divisions.findIndex(
        (division) => division.id === event.divisionId,
      );
      if (at >= 0) divisions.splice(at, 1);
      return;
    }

    case "division_equipment_changed": {
      const division = state.nations[event.nation].divisions.find(
        (candidate) => candidate.id === event.divisionId,
      );
      if (division === undefined) return;
      for (const [index, amount] of event.delta) {
        division.equipment[index] = Math.max(
          0,
          division.equipment[index] + amount,
        );
      }
      return;
    }

    case "formation_raised": {
      const nation = state.nations[event.nation];
      nation.formations.push({
        id: nation.nextFormationId++,
        template: event.template,
        base: event.base,
        // Raised on the ground and empty, for the same reason a division is:
        // it draws from the stockpile over the following ticks, and a nation
        // that raises more wings than it can equip has weaker ones rather
        // than fewer (invariant 2).
        zone: null,
        mission: null,
        equipment: new Array<number>(EQUIPMENT_TYPES.length).fill(0),
      });
      return;
    }

    case "formation_disbanded": {
      const formations = state.nations[event.nation].formations;
      const at = formations.findIndex(
        (formation) => formation.id === event.formationId,
      );
      if (at >= 0) formations.splice(at, 1);
      return;
    }

    case "formation_assigned": {
      const formation = state.nations[event.nation].formations.find(
        (candidate) => candidate.id === event.formationId,
      );
      if (formation === undefined) return;
      // Zone and mission move together. A formation assigned to a zone with
      // no mission would be in the sky doing nothing while paying the zone's
      // attrition, which is a state a player cannot have meant to ask for.
      formation.zone = event.zone;
      formation.mission = event.mission;
      return;
    }

    case "formation_equipment_changed": {
      const formation = state.nations[event.nation].formations.find(
        (candidate) => candidate.id === event.formationId,
      );
      if (formation === undefined) return;
      for (const [index, amount] of event.delta) {
        formation.equipment[index] = Math.max(
          0,
          formation.equipment[index] + amount,
        );
      }
      return;
    }

    case "agreement_proposed": {
      // The id is assigned here, not by the caller, so a replay of the same
      // command log hands out the same ids in the same order.
      state.agreements.push({
        id: state.nextAgreementId++,
        type: event.type,
        parties: [event.nation, event.other],
        terms: event.terms === null ? null : { ...event.terms },
        accepted: false,
        noticeAt: null,
        noticeBy: null,
      });
      return;
    }

    case "agreement_accepted": {
      const agreement = state.agreements.find(
        (candidate) => candidate.id === event.agreementId,
      );
      if (agreement !== undefined) agreement.accepted = true;
      return;
    }

    case "agreement_withdrawn":
    case "agreement_dissolved": {
      const at = state.agreements.findIndex(
        (candidate) => candidate.id === event.agreementId,
      );
      if (at >= 0) state.agreements.splice(at, 1);
      return;
    }

    case "agreement_notice_given": {
      const agreement = state.agreements.find(
        (candidate) => candidate.id === event.agreementId,
      );
      if (agreement === undefined) return;
      // Notice is given once. A second cancellation of the same agreement
      // must not restart the clock — that would be a way to keep an
      // obligation alive by repeatedly announcing its end.
      if (agreement.noticeAt !== null) return;
      agreement.noticeAt = state.tick;
      agreement.noticeBy = event.nation;
      return;
    }

    case "trust_changed": {
      const nation = state.nations[event.nation];
      nation.trust = Math.max(
        TRUST_MIN,
        Math.min(TRUST_MAX, nation.trust + event.delta),
      );
      return;
    }

    case "nation_seen":
      state.nations[event.nation].lastSeenTick = state.tick;
      return;

    case "market_order_set":
      state.nations[event.nation].market[event.resource] = event.perTick;
      return;

    case "invasion_started": {
      const nation = state.nations[event.nation];
      nation.seaTransits.push({
        id: nation.nextTransitId++,
        divisionId: event.divisionId,
        from: event.from,
        to: event.to,
        path: [...event.path],
        ticksLeft: event.ticks,
      });
      const division = nation.divisions.find(
        (it) => it.id === event.divisionId,
      );
      if (division !== undefined) division.province = AT_SEA;
      return;
    }

    case "invasion_progressed": {
      const transit = state.nations[event.nation].seaTransits.find(
        (it) => it.id === event.id,
      );
      if (transit !== undefined && transit.ticksLeft > 0) transit.ticksLeft--;
      return;
    }

    case "invasion_landed": {
      const nation = state.nations[event.nation];
      const at = nation.seaTransits.findIndex((it) => it.id === event.id);
      if (at < 0) return;
      const transit = nation.seaTransits[at];
      const division = nation.divisions.find(
        (it) => it.id === transit.divisionId,
      );
      if (division !== undefined) {
        // Ashore where it aimed, or back on the beach it left from — a
        // garrisoned shore turns a landing back rather than destroying it.
        division.province = event.landed ? transit.to : transit.from;
      }
      nation.seaTransits.splice(at, 1);
      return;
    }

    case "attack_ordered": {
      const attacks = state.nations[event.nation].attacks;
      // Ordering the same attack twice does not restart it. `since` is what a
      // later phase will read to know how long a front has been grinding, and
      // a player clicking twice must not be able to reset that.
      if (attacks.some((attack) => attack.province === event.province)) return;
      attacks.push({
        province: event.province,
        since: state.tick,
        progress: 0,
      });
      return;
    }

    case "attack_progressed": {
      const attacks = state.nations[event.nation].attacks;
      const attack = attacks.find((it) => it.province === event.province);
      // An absolute value, not a delta: the reducer must land on the same
      // number whether it is applied live or replayed, and accumulating
      // floats in two places is how replays drift.
      if (attack !== undefined) {
        attack.progress = Math.min(1, Math.max(0, event.progress));
      }
      return;
    }

    case "attack_ended": {
      const attacks = state.nations[event.nation].attacks;
      const at = attacks.findIndex(
        (attack) => attack.province === event.province,
      );
      if (at >= 0) attacks.splice(at, 1);
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
