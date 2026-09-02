/**
 * The sky: fighters over what is threatened, bombers over what is attacked.
 *
 * §6.7's three effects are what the missions buy — a wing on
 * `air_superiority` decides who owns the zone, `ground_support` makes a
 * front hit harder, `strategic_bombing` and `interdiction` hurt the other
 * side's factories and supply. The regent flies fighters where somebody else
 * is flying, over its own fronts when nobody is, and over home when there is
 * nothing to do; bombers go over the enemy's zone when the steward is the
 * aggressive kind, over the front otherwise.
 */

import {
  REGENT_BOMBER_STOCK,
  REGENT_WING_STOCK,
} from "src/shared/config/regent";
import type { Mission } from "src/shared/economy/Formations";
import type { WorldEvent } from "../../world/WorldState";
import { mineOf, raise, reachable, send } from "./formations";
import type { Situation } from "./situation";

/** Zones in order of what the fighters should care about. */
function fighterZones(s: Situation): { zones: number[]; mission: Mission }[] {
  const threatened = [...s.airThreat.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([zone]) => zone);
  const fronts = [...s.frontZones].sort((a, b) => a - b);
  const home = [...s.myAirZones].sort((a, b) => a - b);
  return [
    { zones: threatened, mission: "air_superiority" },
    { zones: fronts, mission: "ground_support" },
    { zones: home, mission: "air_superiority" },
  ];
}

function bomberZones(s: Situation): { zones: number[]; mission: Mission }[] {
  const targets = s.attacks
    .map((attack) => s.state.map.provinces[attack.province].airZone)
    .sort((a, b) => a - b);
  const fronts = [...s.frontZones].sort((a, b) => a - b);
  const threatened = [...s.border.entries()]
    .filter(([, b]) => b.threat > 0.5)
    .map(([p]) => s.state.map.provinces[p].airZone)
    .sort((a, b) => a - b);
  const t = s.temperament;
  return t.aggression >= 0.6
    ? [
        { zones: targets, mission: "strategic_bombing" },
        { zones: fronts, mission: "ground_support" },
        { zones: threatened, mission: "interdiction" },
      ]
    : [
        { zones: fronts, mission: "ground_support" },
        { zones: threatened, mission: "interdiction" },
        { zones: targets, mission: "strategic_bombing" },
      ];
}

export function air(s: Situation): WorldEvent[] {
  if (s.bases.air.length === 0) return [];
  const t = s.temperament;
  const events: WorldEvent[] = [];
  const wings = 1 + Math.round(t.air * 3);
  events.push(...raise(s, "fighter_wing", REGENT_WING_STOCK, wings));
  if (events.length === 0 && t.aggression >= 0.6 && t.air >= 0.4) {
    events.push(
      ...raise(s, "bomber_wing", REGENT_BOMBER_STOCK, Math.max(1, wings - 1)),
    );
  }
  for (const template of ["fighter_wing", "bomber_wing"] as const) {
    const wants =
      template === "fighter_wing" ? fighterZones(s) : bomberZones(s);
    for (const wing of mineOf(s, template)) {
      let sent = false;
      for (const want of wants) {
        const zone = reachable(s, wing, want.zones);
        if (zone === null) continue;
        events.push(...send(s, wing, zone, want.mission));
        sent = true;
        break;
      }
      if (!sent) events.push(...send(s, wing, null, null));
    }
  }
  return events;
}
