/**
 * Divisions: how many, and where they stand.
 *
 * The first regent raised one division, in the capital, and nothing else —
 * so every other province was a free march for anyone. This one garrisons
 * up to what its supply sources can carry, scaled by `caution`, and puts
 * them where the threat is: the capital first, then the borders facing
 * nations it is not at peace with, then — under an offensive focus — a
 * stack in the staging province the war rule picked.
 *
 * One division per visit, and none while another is starving: a division
 * draws from the same stockpile as its neighbours, and raising a second
 * before the first is fed is the bottomless pit the phase-8 gate found.
 */

import { MAX_DIVISIONS } from "src/shared/config/limits";
import { DIVISION_MANPOWER } from "src/shared/config/rates";
import {
  REGENT_GARRISON_SUPPLY,
  REGENT_STARVING,
} from "src/shared/config/regent";
import { divisionStrength, type WorldEvent } from "../../world/WorldState";
import { STACK, type Situation } from "./situation";
import { stagingFor } from "./war";

/** How many divisions this steward wants standing, all told. */
export function wantedDivisions(s: Situation): number {
  const byCaution = Math.round(s.capacity * (0.5 + s.temperament.caution));
  return Math.max(1, Math.min(MAX_DIVISIONS, byCaution));
}

export function garrison(s: Situation): WorldEvent[] {
  const { me, nation } = s;
  if (me.manpower < DIVISION_MANPOWER) return [];
  if (me.divisions.length >= MAX_DIVISIONS) return [];
  const ownedSet = new Set(s.owned);

  // The capital, before anything else — even a starving army does not leave
  // the capital empty, because an empty capital falls to a march.
  if (
    s.capital !== null &&
    ownedSet.has(s.capital) &&
    (s.divisionsAt.get(s.capital) ?? []).length === 0
  ) {
    return raise(nation, s.capital);
  }

  if (me.divisions.length >= wantedDivisions(s)) return [];
  if (
    me.divisions.some(
      (division) =>
        division.province >= 0 && divisionStrength(division) < REGENT_STARVING,
    )
  ) {
    return [];
  }

  // An offensive stacks the staging province up to the combat width before
  // it spreads along the border: forces do not pool across neighbours.
  const staging = stagingFor(s);
  if (staging !== null && ownedSet.has(staging)) {
    const there = s.divisionsAt.get(staging) ?? [];
    if (there.length < STACK && s.supplyOf(staging) >= REGENT_GARRISON_SUPPLY) {
      return raise(nation, staging);
    }
  }

  // Borders by threat, highest first; ties by province id for determinism.
  const candidates = [...s.border.entries()]
    .filter(([p]) => ownedSet.has(p))
    .filter(([p]) => (s.divisionsAt.get(p) ?? []).length === 0)
    .filter(([p]) => s.supplyOf(p) >= REGENT_GARRISON_SUPPLY)
    .sort((a, b) => b[1].threat - a[1].threat || a[0] - b[0]);
  const first = candidates[0];
  if (first !== undefined) return raise(nation, first[0]);
  return [];
}

function raise(nation: number, province: number): WorldEvent[] {
  return [
    { kind: "division_raised", nation, province },
    { kind: "manpower_changed", nation, delta: -DIVISION_MANPOWER },
  ];
}
