/**
 * The front: where the steward attacks from, what it attacks, and when it
 * stops.
 *
 * §6.10: `expansion` places "offensive orders against the weakest adjacent
 * border with which no agreement exists"; `defence` places none. Decision
 * 0028 adds one thing at Max's call: the marshal — aggressive and careful
 * both — attacks under `military` too, one front at a time. How many fronts
 * an expander holds open is its aggression.
 *
 * An attack is staged from a border province of mine. Empty enemy ground is
 * marched into and needs no army (combat.ts); a garrisoned province needs a
 * standing division of mine next to it, and combat takes the single best
 * adjacent stack — so the garrison rule stacks the staging province rather
 * than spreading along the line.
 */

import { TERRAIN_DEFENCE } from "src/shared/config/combat";
import {
  REGENT_ATTACK_STRENGTH,
  REGENT_RETREAT_STRENGTH,
} from "src/shared/config/regent";
import { divisionStrength, type WorldEvent } from "../../world/WorldState";
import type { Situation } from "./situation";

/** How many fronts this steward may hold open; zero for the peaceable. */
export function frontsAllowed(s: Situation): number {
  const t = s.temperament;
  if (s.focus === "expansion") return 1 + Math.floor(t.aggression * 2);
  if (s.focus === "military" && t.archetype === "marshal") return 1;
  return 0;
}

interface Target {
  from: number;
  province: number;
  score: number;
}

/** My strength standing in a province, as combat would count it. */
function strengthAt(s: Situation, province: number): number {
  return (s.divisionsAt.get(province) ?? [])
    .map(divisionStrength)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, v) => sum + v, 0);
}

/** Enemy strength holding a province. */
function garrisonOf(s: Situation, province: number): number {
  const holder = s.state.provinceController[province];
  if (holder <= 0) return 0;
  return s.state.nations[holder].divisions
    .filter((d) => d.province === province)
    .reduce((sum, d) => sum + divisionStrength(d), 0);
}

/** Every attack the steward could order now, best first. */
function targets(s: Situation): Target[] {
  const t = s.temperament;
  const attacking = new Set(s.attacks.map((a) => a.province));
  const found: Target[] = [];
  for (const [from, border] of s.border) {
    const mine = strengthAt(s, from);
    for (const province of border.hostile) {
      if (attacking.has(province)) continue;
      const garrison = garrisonOf(s, province);
      // A held province needs a real stack next to it; empty ground does not.
      if (garrison > 0 && mine < REGENT_ATTACK_STRENGTH) continue;
      if (garrison > 0 && s.supplyOf(from) < REGENT_ATTACK_STRENGTH) continue;
      const info = s.state.map.provinces[province];
      const defence = garrison * (TERRAIN_DEFENCE[info.terrain] ?? 1);
      const prize =
        Object.values(info.resourceDeposits).reduce((a, b) => a + (b ?? 0), 0) *
          t.industry *
          0.1 +
        (info.coastal ? t.naval * 0.2 : 0);
      found.push({ from, province, score: mine - defence + prize });
    }
  }
  return found.sort(
    (a, b) => b.score - a.score || a.province - b.province || a.from - b.from,
  );
}

/** The province the garrison rule should stack for the next attack. */
export function stagingFor(s: Situation): number | null {
  if (frontsAllowed(s) === 0) return null;
  // A standing front's own staging first, then the best target's.
  for (const attack of s.attacks) {
    for (const [from, border] of s.border) {
      if (border.hostile.includes(attack.province)) return from;
    }
  }
  return targets(s)[0]?.from ?? null;
}

export function war(s: Situation): WorldEvent[] {
  const events: WorldEvent[] = [];
  const { nation } = s;

  // The retreat: an attack whose staging has crumbled is called off rather
  // than left grinding the last equipment out of a lost fight.
  for (const attack of s.attacks) {
    const staging = s.state.map.provinces[attack.province].neighbours.filter(
      (province) => s.state.provinceController[province] === nation,
    );
    const standing = staging.some((province) =>
      (s.divisionsAt.get(province) ?? []).some(
        (division) => divisionStrength(division) >= REGENT_RETREAT_STRENGTH,
      ),
    );
    const contested = garrisonOf(s, attack.province) > 0;
    if (contested && !standing) {
      events.push({ kind: "attack_ended", nation, province: attack.province });
    }
  }

  const open = s.attacks.length - events.length;
  if (open >= frontsAllowed(s)) return events;
  const next = targets(s)[0];
  if (next !== undefined && next.score > -Infinity) {
    events.push({ kind: "attack_ordered", nation, province: next.province });
  }
  return events;
}
