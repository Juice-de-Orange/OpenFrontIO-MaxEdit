/**
 * Wings and fleets, the part shared by the air and the sea rules: raising a
 * formation at a base, sending it somewhere with a mission, bringing it
 * home to refill.
 *
 * Everything here mirrors what `rejectionFor` demands of a player: the base
 * building in a province held *and* owned, the manpower, the ceiling on
 * formations, a mission the template is any good at, a zone in reach of the
 * base. The regent never sends a wing where a player could not.
 */

import { WING_MANPOWER } from "src/shared/config/air";
import { MAX_FORMATIONS } from "src/shared/config/limits";
import { REGENT_STAND_DOWN } from "src/shared/config/regent";
import { equipmentIndex } from "src/shared/economy/Equipment";
import {
  FORMATIONS,
  type FormationTemplate,
  type Mission,
} from "src/shared/economy/Formations";
import { zoneInReach } from "src/shared/map/Zones";
import {
  countBuilding,
  formationStrength,
  type Formation,
  type WorldEvent,
} from "../../world/WorldState";
import type { Situation } from "./situation";

/** My formations of one template, ascending by id. */
export function mineOf(s: Situation, template: FormationTemplate): Formation[] {
  return s.me.formations.filter((f) => f.template === template);
}

/** Raise one, if the base, the stock, the men and the ceiling allow. */
export function raise(
  s: Situation,
  template: FormationTemplate,
  stock: number,
  cap: number,
): WorldEvent[] {
  const spec = FORMATIONS[template];
  if (s.me.manpower < WING_MANPOWER) return [];
  if (s.me.formations.length >= MAX_FORMATIONS) return [];
  if (mineOf(s, template).length >= cap) return [];
  for (const [type, wanted] of Object.entries(spec.equipment)) {
    const held = s.me.stockpile[equipmentIndex(type as never)] ?? 0;
    // Half a template in store, at least the stock the rule asks for.
    if (held < Math.min(stock, (wanted ?? 0) / 2)) return [];
  }
  const base = s.owned.find((p) => countBuilding(s.state, p, spec.base) > 0);
  if (base === undefined) return [];
  return [
    { kind: "formation_raised", nation: s.nation, template, base },
    { kind: "manpower_changed", nation: s.nation, delta: -WING_MANPOWER },
  ];
}

/** The first of the wanted zones the formation can actually reach. */
export function reachable(
  s: Situation,
  formation: Formation,
  zones: readonly number[],
): number | null {
  const kind = FORMATIONS[formation.template].kind;
  for (const zone of zones) {
    if (zoneInReach(s.state.map, formation.base, zone, kind)) return zone;
  }
  return null;
}

/**
 * Send a formation to a zone with a mission — or leave it where it is when
 * that is already where it is. A formation too weak to fight is brought
 * home instead, whatever it was asked to do.
 */
export function send(
  s: Situation,
  formation: Formation,
  zone: number | null,
  mission: Mission | null,
): WorldEvent[] {
  const spec = FORMATIONS[formation.template];
  if (formationStrength(formation) < REGENT_STAND_DOWN) {
    zone = null;
    mission = null;
  }
  if (zone !== null && mission !== null) {
    if ((spec.weight[mission] ?? 0) <= 0) return [];
    if (!zoneInReach(s.state.map, formation.base, zone, spec.kind)) return [];
    if (s.state.provinceController[formation.base] !== s.nation) return [];
  }
  if (formation.zone === zone && formation.mission === mission) return [];
  return [
    {
      kind: "formation_assigned",
      nation: s.nation,
      formationId: formation.id,
      zone,
      mission,
    },
  ];
}
