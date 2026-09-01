/**
 * The sea's graph: which sea zones touch which, and how far apart they are.
 *
 * Phase 9 needs the ocean to be routable — convoy routes and invasion paths
 * cross zones — and the handover assumed that meant water *provinces* and a
 * `provinces.bin` format bump. It does not: everything the sea's consumers
 * ask for (adjacency, distance, a path) is a property of the sea zones the
 * artefact already carries per tile, so the graph is derived here at load
 * the way `borderTiles` is, and the format stays at 1
 * (docs/decisions/0017).
 *
 * Note what this deliberately is not: `zoneNeighbours(map, "naval")` in
 * `server/systems/zones.ts` derives sea-zone adjacency *through coastal land
 * provinces*, which is right for the question it answers — where a fleet
 * based at a port may be sent — and wrong for routing, because two zones
 * meeting in open ocean share no coastal province. This graph is the water's
 * own adjacency, tile against tile.
 */

import type { ProvinceMap } from "./ProvinceMap";

/** Derived once per decoded map; the map object is the cache key. */
const ADJACENCY = new WeakMap<
  ProvinceMap,
  ReadonlyArray<ReadonlySet<number>>
>();

/** Sea-zone adjacency over water tiles, indexed by zone id. */
export function seaZoneAdjacency(
  map: ProvinceMap,
): ReadonlyArray<ReadonlySet<number>> {
  const known = ADJACENCY.get(map);
  if (known !== undefined) return known;

  const sets: Set<number>[] = [];
  for (let zone = 0; zone < map.seaZoneCount; zone++) sets.push(new Set());
  const zoneOf = map.seaZoneOfTile;
  const { width, height } = map;
  const join = (a: number, b: number): void => {
    if (a < 0 || b < 0 || a === b) return;
    sets[a].add(b);
    sets[b].add(a);
  };
  // Right and down cover every tile pair once; `join` writes both directions.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const tile = row + x;
      const here = zoneOf[tile];
      if (here < 0) continue;
      if (x + 1 < width) join(here, zoneOf[tile + 1]);
      if (y + 1 < height) join(here, zoneOf[tile + width]);
    }
  }

  const frozen: ReadonlyArray<ReadonlySet<number>> = sets;
  ADJACENCY.set(map, frozen);
  return frozen;
}

/**
 * The shortest sea path between two zones, as the zones it passes through —
 * both ends included — or null when no chain of touching zones connects
 * them. Zero-length seas do not exist: a path from a zone to itself is that
 * one zone.
 *
 * Plain breadth-first search: Europe has 35 sea zones, and every consumer
 * (a convoy route when supply recomputes, an invasion when it is ordered)
 * asks rarely enough that caching would be more code than the search.
 */
export function seaPath(
  map: ProvinceMap,
  from: number,
  to: number,
): number[] | null {
  const zones = seaZoneAdjacency(map);
  if (from < 0 || to < 0 || from >= zones.length || to >= zones.length) {
    return null;
  }
  if (from === to) return [from];

  const cameFrom = new Map<number, number>([[from, from]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const zone = queue[head];
    for (const next of zones[zone]) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, zone);
      if (next === to) {
        const path = [to];
        let at = to;
        while (at !== from) {
          at = cameFrom.get(at) as number;
          path.push(at);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/** Sea distance in zones crossed — `seaPath`'s length minus one, or null. */
export function seaDistance(
  map: ProvinceMap,
  from: number,
  to: number,
): number | null {
  const path = seaPath(map, from, to);
  return path === null ? null : path.length - 1;
}
