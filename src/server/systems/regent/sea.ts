/**
 * The sea: §6.10's own sentence first — "keep enough fleets on
 * `convoy_escort` to cover active convoy demand" — and then what the
 * temperament adds. Escorts sail the zones my convoys cross, the one being
 * raided first; submarines, for the aggressive admiral, hunt the routes of
 * nations I am not at peace with; a battle fleet, for the admiral proper,
 * holds the home zone.
 */

import {
  REGENT_ESCORT_STOCK,
  REGENT_FLEET_STOCK,
  REGENT_SUB_STOCK,
} from "src/shared/config/regent";
import type { WorldEvent } from "../../world/WorldState";
import { netRaidOver } from "../supply";
import { mineOf, raise, reachable, send } from "./formations";
import type { Situation } from "./situation";

export function sea(s: Situation): WorldEvent[] {
  if (s.bases.naval.length === 0) return [];
  const t = s.temperament;
  const events: WorldEvent[] = [];
  const fleets = 1 + Math.round(t.naval * 3);

  // The escort duty. Zones my convoys cross, the raided one first.
  const routeZones = [...s.sea.routeZones].sort(
    (a, b) =>
      netRaidOver(s.state, s.nation, b) - netRaidOver(s.state, s.nation, a) ||
      a - b,
  );
  if (s.sea.convoysWanted > 0 && routeZones.length > 0) {
    events.push(
      ...raise(
        s,
        "escort_group",
        REGENT_ESCORT_STOCK,
        Math.min(fleets, routeZones.length),
      ),
    );
  }
  const escorts = mineOf(s, "escort_group");
  escorts.forEach((escort, i) => {
    // Spread over the route zones in reach, one per zone, raided first.
    const zone = reachable(s, escort, [
      ...routeZones.slice(i),
      ...routeZones.slice(0, i),
    ]);
    events.push(
      ...send(s, escort, zone, zone === null ? null : "convoy_escort"),
    );
  });

  // The hunt, for the aggressive kind.
  if (events.length === 0 && t.aggression * t.naval >= 0.4) {
    const hunting = s.sea.enemySeaZones();
    if (hunting.length > 0) {
      events.push(...raise(s, "submarine_flotilla", REGENT_SUB_STOCK, fleets));
    }
    for (const flotilla of mineOf(s, "submarine_flotilla")) {
      const zone = reachable(s, flotilla, hunting);
      events.push(
        ...send(s, flotilla, zone, zone === null ? null : "convoy_raiding"),
      );
    }
  }

  // The fleet in being, for the admiral.
  if (t.naval >= 0.7 && s.factories.dockyard.total >= 3) {
    if (events.length === 0) {
      events.push(...raise(s, "battle_fleet", REGENT_FLEET_STOCK, 1));
    }
    for (const fleet of mineOf(s, "battle_fleet")) {
      const home = s.state.map.provinces[fleet.base].seaZone;
      events.push(
        ...send(s, fleet, home, home === null ? null : "sea_control"),
      );
    }
  }
  return events;
}
