/**
 * The construction queue: what the steward builds next, and where.
 *
 * One order per visit, the queue kept shallow (`REGENT_QUEUE_DEPTH`) so the
 * construction points are not spread over a dozen half-built things. The
 * order of the rules is the order of need: a starving division's hub, a
 * threatened border's hub, the air base when somebody is over the zone, the
 * dockyard and naval base when the sea carries the supply, a refinery when
 * the market cannot cover the shortfall, a mine upgrade for the builder —
 * and only then what the focus and the temperament would build for its own
 * sake.
 */

import { MAX_QUEUE_LENGTH } from "src/shared/config/limits";
import {
  REGENT_HUB_BELOW,
  REGENT_QUEUE_DEPTH,
  type RegentFocus,
} from "src/shared/config/regent";
import type { Archetype } from "src/shared/config/temperament";
import { BUILDINGS, type BuildingType } from "src/shared/economy/Buildings";
import { zoneNeighbours } from "src/shared/map/Zones";
import {
  countBuilding,
  effectiveInfrastructure,
  usedSlots,
  type WorldEvent,
  type WorldState,
} from "../../world/WorldState";
import type { Situation } from "./situation";

/** What each focus builds when nothing is pressing, in order of preference. */
const FOCUS_BUILDINGS: Readonly<Record<RegentFocus, readonly BuildingType[]>> =
  {
    economy: ["civilian_factory", "infrastructure"],
    military: ["military_factory", "civilian_factory"],
    defence: ["supply_hub", "military_factory"],
    expansion: ["military_factory", "infrastructure"],
  };

/** And what each temperament reaches for first, ahead of the focus. */
const ARCHETYPE_BUILDINGS: Readonly<
  Record<Archetype, readonly BuildingType[]>
> = {
  builder: ["civilian_factory", "infrastructure"],
  scholar: ["civilian_factory", "infrastructure"],
  warden: ["supply_hub", "military_factory"],
  marshal: ["military_factory", "supply_hub"],
  conqueror: ["military_factory", "infrastructure"],
  admiral: ["dockyard", "civilian_factory"],
  airman: ["air_base", "military_factory"],
};

/**
 * Whether this building can go in this province right now — the same rules
 * `rejectionForQueue` applies to a player, including the queued orders that
 * already hold a slot and the infrastructure level the province has by
 * itself.
 */
export function buildable(
  state: WorldState,
  nation: number,
  province: number,
  building: BuildingType,
): boolean {
  const spec = BUILDINGS[building];
  const info = state.map.provinces[province];
  if (info === undefined) return false;
  if (state.provinceController[province] !== nation) return false;
  if (state.provinceOwner[province] !== nation) return false;
  if (spec.coastalOnly && !info.coastal) return false;
  const queue = state.nations[nation].constructionQueue;
  if (queue.length >= MAX_QUEUE_LENGTH) return false;
  const queuedHere = queue.filter((order) => order.provinceId === province);
  if (spec.takesSlot) {
    const pending = queuedHere.filter(
      (order) => BUILDINGS[order.building].takesSlot,
    ).length;
    if (usedSlots(state, province) + pending >= info.buildingSlots)
      return false;
  }
  if (spec.maxPerProvince !== undefined) {
    const pending = queuedHere.filter(
      (order) => order.building === building,
    ).length;
    const existing =
      building === "infrastructure"
        ? effectiveInfrastructure(state, province)
        : countBuilding(state, province, building);
    if (existing + pending >= spec.maxPerProvince) return false;
  }
  return true;
}

function queued(s: Situation, building: BuildingType): boolean {
  return s.me.constructionQueue.some((order) => order.building === building);
}

function order(
  s: Situation,
  province: number,
  building: BuildingType,
): WorldEvent[] {
  return [
    {
      kind: "construction_queued",
      nation: s.nation,
      order: { provinceId: province, building, progress: 0 },
    },
  ];
}

/** The first of my owned provinces where the building fits, ascending. */
function firstFit(
  s: Situation,
  building: BuildingType,
  among = s.owned,
): number | null {
  for (const province of among) {
    if (buildable(s.state, s.nation, province, building)) return province;
  }
  return null;
}

/** My province in the threatened zone, else one whose zone borders it, else the capital. */
function provinceForAirBase(s: Situation, zone: number): number | null {
  const inZone = s.owned.filter(
    (p) => s.state.map.provinces[p].airZone === zone,
  );
  const there = firstFit(s, "air_base", inZone);
  if (there !== null) return there;
  const near =
    zoneNeighbours(s.state.map, "air").get(zone) ?? new Set<number>();
  const beside = s.owned.filter((p) =>
    near.has(s.state.map.provinces[p].airZone),
  );
  const next = firstFit(s, "air_base", beside);
  if (next !== null) return next;
  return firstFit(s, "air_base");
}

/** How many of a building stand in the provinces I own. */
function total(s: Situation, building: BuildingType): number {
  let n = 0;
  for (const p of s.owned) n += countBuilding(s.state, p, building);
  return n;
}

export function build(s: Situation): WorldEvent[] {
  if (s.me.constructionQueue.length >= REGENT_QUEUE_DEPTH) return [];
  const { temperament: t } = s;

  // 1. A starving division's hub — the bottomless-pit lesson.
  for (const [province, divisions] of s.divisionsAt) {
    if (divisions.length === 0) continue;
    if (s.supplyOf(province) >= REGENT_HUB_BELOW) continue;
    if (countBuilding(s.state, province, "supply_hub") > 0) continue;
    if (!buildable(s.state, s.nation, province, "supply_hub")) continue;
    return order(s, province, "supply_hub");
  }
  // 2. A threatened border nobody could hold for want of supply.
  if (!queued(s, "supply_hub")) {
    const thin = [...s.border.entries()]
      .filter(([p, b]) => b.threat > 0 && s.supplyOf(p) < REGENT_HUB_BELOW)
      .filter(([p]) => countBuilding(s.state, p, "supply_hub") === 0)
      .filter(([p]) => buildable(s.state, s.nation, p, "supply_hub"))
      .sort((a, b) => b[1].threat - a[1].threat || a[0] - b[0]);
    if (thin[0] !== undefined) return order(s, thin[0][0], "supply_hub");
  }
  // 3. An air base where somebody is over the zone, or for the airman.
  if (s.bases.air.length === 0 && !queued(s, "air_base")) {
    const threatened = [...s.airThreat.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    )[0];
    if (threatened !== undefined || t.air >= 0.6) {
      const zone =
        threatened?.[0] ??
        (s.capital !== null ? s.state.map.provinces[s.capital].airZone : null);
      const province =
        zone === null ? firstFit(s, "air_base") : provinceForAirBase(s, zone);
      if (province !== null) return order(s, province, "air_base");
    }
  }
  // 4. The sea, when the supply or the temperament runs on it.
  if (
    s.coastal &&
    (s.sea.routes.length > 0 || s.sea.island || t.naval >= 0.6)
  ) {
    const yards = s.factories.dockyard.total;
    if (yards === 0 && !queued(s, "dockyard")) {
      const province = firstFit(s, "dockyard");
      if (province !== null) return order(s, province, "dockyard");
    }
    if (s.bases.naval.length === 0 && !queued(s, "naval_base")) {
      const province = firstFit(s, "naval_base");
      if (province !== null) return order(s, province, "naval_base");
    }
  }
  // 5. The builder's mines: the richest deposit first — but a mine per
  // factory, not mines until the ground is empty, or nothing else is built.
  if (
    t.industry >= 0.5 &&
    !queued(s, "extraction_upgrade") &&
    total(s, "extraction_upgrade") <= total(s, "civilian_factory")
  ) {
    const rich = [...s.owned]
      .map((p) => ({
        p,
        deposits: Object.values(
          s.state.map.provinces[p].resourceDeposits,
        ).reduce((sum, v) => sum + (v ?? 0), 0),
      }))
      .filter((it) => it.deposits > 0)
      .filter((it) => buildable(s.state, s.nation, it.p, "extraction_upgrade"))
      .sort((a, b) => b.deposits - a.deposits || a.p - b.p);
    if (rich[0] !== undefined) return order(s, rich[0].p, "extraction_upgrade");
  }
  // 6. What the temperament and the focus would build for its own sake.
  for (const building of [
    ...ARCHETYPE_BUILDINGS[t.archetype],
    ...FOCUS_BUILDINGS[s.focus],
  ]) {
    const province = firstFit(s, building);
    if (province !== null) return order(s, province, building);
  }
  return [];
}
