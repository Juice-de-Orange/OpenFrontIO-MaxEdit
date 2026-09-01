/**
 * Whether goods can move between two nations, and by which way.
 *
 * Phase 7 asked one question — are they on the same landmass — and asked it
 * only at proposal and acceptance. Phase 9 asks every tick, because the
 * answer now prices the flow: a land route is free, a sea route consumes
 * convoys and can be raided, and no route at all moves nothing this tick
 * without breaking the agreement (§6.5 — the flow scales, the commitment
 * stands).
 */

import { seaZoneAdjacency } from "src/shared/map/SeaGraph";
import type { WorldState } from "../world/WorldState";

/** How one agreement's goods travel this tick. */
export type TradeRoute =
  | { kind: "land" }
  | { kind: "sea"; path: readonly number[]; zones: number }
  | { kind: "none" };

/**
 * Whether a trade could be carried between these two nations over land.
 *
 * A breadth-first search over the province graph, which holds land only. It
 * crosses third parties' territory without asking: §6.5 gives transit rights
 * to allies for *units*, and says nothing about goods, so a land route is
 * not something anyone can veto by standing in the way.
 */
export function landRouteBetween(
  state: WorldState,
  a: number,
  b: number,
): boolean {
  const seen = new Uint8Array(state.provinceController.length);
  const queue: number[] = [];
  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] !== a) continue;
    seen[province] = 1;
    queue.push(province);
  }
  if (queue.length === 0) return false;
  for (let head = 0; head < queue.length; head++) {
    const province = queue[head];
    if (state.provinceController[province] === b) return true;
    for (const next of state.map.provinces[province].neighbours) {
      if (seen[next] === 1) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
  return false;
}

/** The sea zones a nation's controlled coastline touches. */
function coastalZonesOf(state: WorldState, nation: number): Set<number> {
  const zones = new Set<number>();
  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] !== nation) continue;
    const zone = state.map.provinces[province].seaZone;
    if (zone !== null) zones.add(zone);
  }
  return zones;
}

/**
 * The shortest sea route between two nations' coastlines, as the sea zones
 * it passes through, or null when no chain of zones connects them (or one of
 * them holds no coast at all).
 *
 * A coastline is enough — §6.5 prices a sea trade in convoys, not in
 * harbours. The port-on-both-ends rule is §6.6's, for supply, and it lives
 * in `supply.ts`.
 */
export function seaRouteBetween(
  state: WorldState,
  a: number,
  b: number,
): readonly number[] | null {
  const from = coastalZonesOf(state, a);
  const to = coastalZonesOf(state, b);
  if (from.size === 0 || to.size === 0) return null;
  for (const zone of from) if (to.has(zone)) return [zone];

  // Multi-source breadth-first over the sea-zone graph, stopping at the
  // first zone the other coastline touches.
  const zones = seaZoneAdjacency(state.map);
  const cameFrom = new Map<number, number>();
  const queue: number[] = [];
  for (const zone of from) {
    cameFrom.set(zone, zone);
    queue.push(zone);
  }
  for (let head = 0; head < queue.length; head++) {
    const zone = queue[head];
    for (const next of zones[zone] ?? []) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, zone);
      if (to.has(next)) {
        const path = [next];
        let at = next;
        while (cameFrom.get(at) !== at) {
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

/** The way one pair of nations trades this tick: land first, then sea. */
export function tradeRouteBetween(
  state: WorldState,
  a: number,
  b: number,
): TradeRoute {
  if (landRouteBetween(state, a, b)) return { kind: "land" };
  const path = seaRouteBetween(state, a, b);
  if (path !== null) return { kind: "sea", path, zones: path.length - 1 };
  return { kind: "none" };
}
