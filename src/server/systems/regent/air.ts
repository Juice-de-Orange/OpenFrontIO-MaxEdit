/**
 * The sky: fight for it where somebody else is flying, use it over the front.
 *
 * §6.7's two effects are what the missions buy — a wing on `air_superiority`
 * decides who owns the zone, `ground_support` makes a front hit harder. The
 * regent flies where somebody else is flying, over its own fronts when
 * nobody is, and over home when there is nothing to do.
 *
 * One template now (decision 0030), so the whole rule is *where*, not
 * *which*: an aggressive steward keeps more wings, a cautious one fewer, and
 * both fly the same aircraft.
 */

import { REGENT_WING_STOCK } from "src/shared/config/regent";
import type { Mission } from "src/shared/economy/Formations";
import type { WorldEvent } from "../../world/WorldState";
import { mineOf, raise, reachable, send } from "./formations";
import type { Situation } from "./situation";

/** Zones in order of what the wings should care about. */
function wantedZones(s: Situation): { zones: number[]; mission: Mission }[] {
  const threatened = [...s.airThreat.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([zone]) => zone);
  const fronts = [...s.frontZones].sort((a, b) => a - b);
  const home = [...s.myAirZones].sort((a, b) => a - b);
  const t = s.temperament;
  // The aggressive kind supports the attack before it contests the sky; the
  // careful kind takes the sky first. Both end up over home with nothing on.
  return t.aggression >= 0.6
    ? [
        { zones: fronts, mission: "ground_support" },
        { zones: threatened, mission: "air_superiority" },
        { zones: home, mission: "air_superiority" },
      ]
    : [
        { zones: threatened, mission: "air_superiority" },
        { zones: fronts, mission: "ground_support" },
        { zones: home, mission: "air_superiority" },
      ];
}

export function air(s: Situation): WorldEvent[] {
  if (s.bases.air.length === 0) return [];
  const t = s.temperament;
  const events: WorldEvent[] = [];
  const wings = 1 + Math.round(t.air * 3);
  events.push(...raise(s, "wing", REGENT_WING_STOCK, wings));

  const wants = wantedZones(s);
  for (const wing of mineOf(s, "wing")) {
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
  return events;
}
