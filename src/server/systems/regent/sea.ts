/**
 * The sea: §6.10's own sentence first — "keep enough fleets on patrol to
 * cover active convoy demand" — and then what the temperament adds.
 *
 * A patrol is a fleet holding a piece of water: it covers the shipping that
 * crosses it and contests it against anybody else there (decision 0030), so
 * the escort duty and sea control are one order now. Raiding is the other
 * thing a navy does, and the aggressive admiral does it: the routes of
 * nations this one is not at peace with, hunted with whatever is left after
 * its own water is covered.
 */

import { REGENT_ESCORT_STOCK } from "src/shared/config/regent";
import type { WorldEvent } from "../../world/WorldState";
import { netRaidOver } from "../supply";
import { mineOf, raise, reachable, send } from "./formations";
import type { Situation } from "./situation";

export function sea(s: Situation): WorldEvent[] {
  if (s.bases.naval.length === 0) return [];
  const t = s.temperament;
  const events: WorldEvent[] = [];
  const wanted = 1 + Math.round(t.naval * 3);

  // Zones my own shipping crosses, the one being raided first.
  const routeZones = [...s.sea.routeZones].sort(
    (a, b) =>
      netRaidOver(s.state, s.nation, b) - netRaidOver(s.state, s.nation, a) ||
      a - b,
  );
  const hunting = t.aggression * t.naval >= 0.4 ? s.sea.enemySeaZones() : [];

  // Raise while there is water to cover or an enemy worth hunting. One a
  // visit, like everything else this steward does.
  if (routeZones.length > 0 || hunting.length > 0 || t.naval >= 0.6) {
    events.push(...raise(s, "fleet", REGENT_ESCORT_STOCK, wanted));
  }

  // **Cover first, hunt with the rest.** A navy that is all out raiding
  // while its own convoys are being sunk has lost the war it is winning.
  const fleets = mineOf(s, "fleet");
  const covering = Math.min(fleets.length, Math.max(1, routeZones.length));
  fleets.forEach((fleet, i) => {
    if (i < covering && routeZones.length > 0) {
      const zone = reachable(s, fleet, [
        ...routeZones.slice(i),
        ...routeZones.slice(0, i),
      ]);
      events.push(...send(s, fleet, zone, zone === null ? null : "patrol"));
      return;
    }
    if (hunting.length > 0) {
      const zone = reachable(s, fleet, hunting);
      if (zone !== null) {
        events.push(...send(s, fleet, zone, "raiding"));
        return;
      }
    }
    // Nothing to cover and nobody to hunt: hold the home water.
    const home = s.state.map.provinces[fleet.base].seaZone;
    events.push(...send(s, fleet, home, home === null ? null : "patrol"));
  });

  return events;
}
