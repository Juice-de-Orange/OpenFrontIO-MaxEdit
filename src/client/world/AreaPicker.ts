/**
 * "Draw the water this fleet patrols."
 *
 * §6.7 and §6.8 assign a formation to a *zone*, and a zone is a number. A
 * player picking one out of a dropdown of thirty-one is picking a number out
 * of a list of numbers; a player dragging a box over the sea is saying where
 * they want their ships. Both end in the same command — this turns the
 * second into the first (decision 0031).
 *
 * The box is resolved by counting: every tile inside it votes for the zone
 * it belongs to, and the zone with the most tiles wins. A box that catches
 * two zones therefore means the one it caught most of, which is what
 * somebody drawing roughly around an area intends.
 *
 * Invariant 8 is intact: the tiles are a projection nobody names. What comes
 * out is a zone id, and the zone is what the command carries.
 */

import type { ZoneKind } from "src/shared/economy/Formations";
import type { ProvinceMap } from "src/shared/map/ProvinceMap";

export interface WorldBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type ZoneSource = Pick<
  ProvinceMap,
  "provinceOfTile" | "seaZoneOfTile" | "provinces"
>;

/** How many tiles a box has to catch before it counts as a choice. */
const MIN_TILES = 4;

/**
 * The zone a drawn box means, or null if it caught nothing of that kind.
 *
 * Sampled rather than walked: a box drawn over half a continent is millions
 * of tiles and the answer does not get better for looking at all of them.
 * The step is chosen so that any box is read at roughly the same cost.
 */
export function zoneUnder(
  grid: ZoneSource,
  width: number,
  height: number,
  box: WorldBox,
  kind: ZoneKind,
): number | null {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width - 1, Math.ceil(box.x1));
  const y1 = Math.min(height - 1, Math.ceil(box.y1));
  if (x1 < x0 || y1 < y0) return null;

  const step = Math.max(
    1,
    Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 4096)),
  );
  const votes = new Map<number, number>();
  let counted = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const tile = y * width + x;
      let zone = -1;
      if (kind === "naval") {
        zone = grid.seaZoneOfTile[tile] ?? -1;
      } else {
        const province = grid.provinceOfTile[tile];
        if (province >= 0) zone = grid.provinces[province]?.airZone ?? -1;
      }
      if (zone < 0) continue;
      votes.set(zone, (votes.get(zone) ?? 0) + 1);
      counted++;
    }
  }
  if (counted < MIN_TILES) return null;

  let best: number | null = null;
  let most = 0;
  // Ascending, so a tie is broken the same way every time.
  for (const zone of [...votes.keys()].sort((a, b) => a - b)) {
    const count = votes.get(zone) ?? 0;
    if (count > most) {
      most = count;
      best = zone;
    }
  }
  return best;
}
