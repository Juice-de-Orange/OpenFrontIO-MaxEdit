/**
 * Zones: the machine air and naval both run on.
 *
 * CLAUDE.md §6.8 is explicit that phase 9's sea zones are **the same code** as
 * §6.7's air zones with a different mission set, and invariant 5 says the same
 * thing from the other direction: one zone abstraction, and any third zoned
 * system reuses it again. So this file knows about zones, formations and
 * missions, and knows nothing about aircraft.
 *
 * Everything that differs between the two lives in `shared/economy/Formations`
 * as data: which zone a template flies in, what it is worth on each mission,
 * and which missions its kind offers. Adding fleets in phase 9 is adding rows
 * to that table, not branches to this one.
 *
 * **Nothing here is cached**, for the reason `supply.ts` sets out at length: a
 * cache is either state that has to be in the snapshot and the hash, or module
 * state that makes a replay depend on how the process was started. A pass over
 * every nation's formations is a pass over a few dozen objects.
 */

import {
  MISSION_FLOOR,
  MISSION_SATURATION,
  SUPERIORITY_CEILING,
  SUPERIORITY_FLOOR,
} from "src/shared/config/air";
import {
  FORMATIONS,
  type Mission,
  type ZoneKind,
} from "src/shared/economy/Formations";
import { zoneInReach, zoneNeighbours, zoneOf } from "src/shared/map/Zones";
import {
  formationStrength,
  type Formation,
  type WorldState,
} from "../world/WorldState";

// The zone geometry — `zoneOf`, `zoneNeighbours`, `zoneInReach` — lives in
// `src/shared/map/Zones.ts` since the client learned to grey out a zone a
// formation cannot reach. Re-exported so the world and the tests keep
// reading it from the zone machine.
export { zoneInReach, zoneNeighbours, zoneOf };

/**
 * What one formation is worth on the mission it was actually given.
 *
 * Zero for a formation standing down, and zero for one whose template has no
 * business on that mission at all — the weight table's zeroes are shape rules
 * (a fleet cannot fly ground support), not shortages.
 */
export function formationPower(formation: Formation): number {
  if (formation.zone === null || formation.mission === null) return 0;
  return (
    formationStrength(formation) *
    FORMATIONS[formation.template].weight[formation.mission]
  );
}

/** Every formation of this kind that a nation has standing in a zone. */
function inZone(
  state: WorldState,
  nation: number,
  zone: number,
  kind: ZoneKind,
): Formation[] {
  if (nation <= 0 || nation > state.nationCount) return [];
  return state.nations[nation].formations.filter(
    (formation) =>
      formation.zone === zone && FORMATIONS[formation.template].kind === kind,
  );
}

/**
 * The contest for a zone: what each nation brings to the fight for it.
 *
 * §6.7 resolves air combat "between opposing wings on `air_superiority`", so
 * that is what decides who owns the sky. A wing on any other mission is in the
 * zone, pays its attrition and does its job — it simply is not what the
 * question "who has superiority here" is asking.
 */
export function contestOf(
  state: WorldState,
  zone: number,
  kind: ZoneKind,
): Map<number, number> {
  const contest = new Map<number, number>();
  const contesting: Mission = kind === "air" ? "air_superiority" : "patrol";
  for (let nation = 1; nation <= state.nationCount; nation++) {
    let power = 0;
    for (const formation of inZone(state, nation, zone, kind)) {
      if (formation.mission !== contesting) continue;
      power += formationPower(formation);
    }
    if (power > 0) contest.set(nation, power);
  }
  return contest;
}

/**
 * A nation's share of a zone, 0..1, with 0.5 a stalemate.
 *
 * Clamped away from both ends (`SUPERIORITY_FLOOR`/`CEILING`) so that being
 * outnumbered is bad rather than total: the last wing in a losing air war is
 * still worth flying, and an unopposed one does not get quite everything.
 *
 * A nation alone over a zone gets the ceiling; a nation with nothing there
 * gets the floor. Neither is zero and neither is one, which is invariant 2
 * applied to a ratio instead of a rate.
 */
export function superiorityOf(
  contest: Map<number, number>,
  nation: number,
): number {
  let total = 0;
  for (const power of contest.values()) total += power;
  const own = contest.get(nation) ?? 0;
  if (total <= 0) return 0.5;
  const share = own / total;
  return Math.max(SUPERIORITY_FLOOR, Math.min(SUPERIORITY_CEILING, share));
}

/** Whether anybody other than this nation has anything contesting the zone. */
export function isContested(
  contest: Map<number, number>,
  nation: number,
): boolean {
  for (const [other, power] of contest) {
    if (other !== nation && power > 0) return true;
  }
  return false;
}

/**
 * How much of a mission a nation is actually flying over a zone, 0..1.
 *
 * Two things scale it, and they are different questions. The raw power
 * saturates — a second wing on the same job adds less than the first, which is
 * what stops a stack of twelve from deciding a province the way a stack of
 * twenty divisions is stopped by combat width. And the result is scaled by
 * superiority, down to `MISSION_FLOOR` rather than to nothing: bombers sent
 * into a sky somebody else owns still do something, badly.
 */
export function missionEffect(
  state: WorldState,
  zone: number,
  nation: number,
  mission: Mission,
  kind: ZoneKind,
): number {
  let power = 0;
  for (const formation of inZone(state, nation, zone, kind)) {
    if (formation.mission !== mission) continue;
    power += formationPower(formation);
  }
  if (power <= 0) return 0;
  const saturated = power / (power + MISSION_SATURATION);
  const superiority = superiorityOf(contestOf(state, zone, kind), nation);
  return saturated * (MISSION_FLOOR + (1 - MISSION_FLOOR) * superiority);
}

/**
 * The same, summed over every nation that is not this one and not at peace
 * with it.
 *
 * This is the shape every *hostile* effect wants — interdiction against my
 * supply, bombing against my factories — because a player does not care which
 * of three enemies is over their industry, only that somebody is. Capped at 1
 * so the caps in `config/air.ts` mean what they say.
 */
export function hostileMissionEffect(
  state: WorldState,
  zone: number,
  against: number,
  mission: Mission,
  kind: ZoneKind,
  atPeaceWith: (a: number, b: number) => boolean,
): number {
  let total = 0;
  for (let nation = 1; nation <= state.nationCount; nation++) {
    if (nation === against) continue;
    if (atPeaceWith(nation, against)) continue;
    total += missionEffect(state, zone, nation, mission, kind);
  }
  return Math.min(1, total);
}
