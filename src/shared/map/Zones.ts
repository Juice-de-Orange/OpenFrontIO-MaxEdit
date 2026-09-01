/**
 * Zone geometry, shared by both sides of the wire.
 *
 * Which zone a province is in, which zones border which, and whether a
 * formation based in one province may be sent to a zone — all static map data
 * derived from the province graph, none of it stored. The server enforces
 * `ZONE_REACH` with these (World.ts refuses an assignment out of reach); the
 * client uses the same functions to grey the zone out *before* the refusal,
 * so the rule is visible rather than discovered. One implementation, or the
 * dropdown and the server would disagree at exactly the border case.
 *
 * Takes anything with a `provinces` array rather than a `ProvinceMap`, because
 * the client has the array (from the full state) and not the tile grids.
 */

import type { ZoneKind } from "../economy/Formations";
import type { Province } from "./Province";

export interface ZoneGraphSource {
  provinces: readonly Province[];
}

/** The zone of this kind a province belongs to, or null if it has none. */
export function zoneOf(
  map: ZoneGraphSource,
  province: number,
  kind: ZoneKind,
): number | null {
  const it = map.provinces[province];
  if (it === undefined) return null;
  return kind === "air" ? it.airZone : it.seaZone;
}

/**
 * Which zones border which, derived from the province graph.
 *
 * Static map data in everything but storage: two zones are neighbours when any
 * province in one borders any province in the other. It is what gives
 * `ZONE_REACH` something to mean, and it is why where a player puts an air
 * base is a decision rather than a formality.
 */
export function zoneNeighbours(
  map: ZoneGraphSource,
  kind: ZoneKind,
): Map<number, Set<number>> {
  const neighbours = new Map<number, Set<number>>();
  const add = (a: number, b: number): void => {
    let set = neighbours.get(a);
    if (set === undefined) {
      set = new Set<number>();
      neighbours.set(a, set);
    }
    set.add(b);
  };
  for (const province of map.provinces) {
    const here = kind === "air" ? province.airZone : province.seaZone;
    if (here === null) continue;
    add(here, here);
    for (const id of province.neighbours) {
      const there = zoneOf(map, id, kind);
      if (there === null) continue;
      add(here, there);
    }
  }
  return neighbours;
}

/** Whether a formation based here may be sent to that zone (`ZONE_REACH`). */
export function zoneInReach(
  map: ZoneGraphSource,
  base: number,
  zone: number,
  kind: ZoneKind,
): boolean {
  const home = zoneOf(map, base, kind);
  if (home === null) return false;
  if (home === zone) return true;
  return zoneNeighbours(map, kind).get(home)?.has(zone) === true;
}
