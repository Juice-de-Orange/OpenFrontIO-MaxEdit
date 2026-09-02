/**
 * One tile per zone, so a wing or a fleet has somewhere to stand.
 *
 * A formation is assigned to a *zone*, not a province — that is the whole
 * point of §6.7 and §6.8 — but a zone is an area and an icon needs a point.
 * This picks the point: the tile nearest the zone's own centre of mass, so
 * the marker sits in the middle of the water it patrols rather than on its
 * edge.
 *
 * Computed once per world, because the partition never moves. Invariant 8
 * is safe here for the same reason it is for a factory's icon: the tile is
 * a projection and no player action ever names it.
 */

import type { ProvinceMap } from "src/shared/map/ProvinceMap";

export interface ZoneAnchors {
  /** Air zone id → tile, for the land the wings fly over. */
  air: Map<number, number>;
  /** Sea zone id → tile, for the water the fleets patrol. */
  sea: Map<number, number>;
}

type AnchorSource = Pick<
  ProvinceMap,
  "provinceOfTile" | "seaZoneOfTile" | "provinces"
>;

/** Sum of x, sum of y, count — a centre of mass, accumulated. */
interface Mass {
  x: number;
  y: number;
  n: number;
}

function accumulate(
  into: Map<number, Mass>,
  zone: number,
  x: number,
  y: number,
): void {
  const mass = into.get(zone);
  if (mass === undefined) into.set(zone, { x, y, n: 1 });
  else {
    mass.x += x;
    mass.y += y;
    mass.n += 1;
  }
}

/**
 * The tile of each zone closest to that zone's centre of mass.
 *
 * Two passes over the tile grid: one to find where each zone's middle is,
 * one to find the tile of that zone nearest to it. The nearest tile rather
 * than the middle itself, because the middle of a horseshoe-shaped sea zone
 * is dry land.
 */
export function zoneAnchors(grid: AnchorSource, width: number): ZoneAnchors {
  const airMass = new Map<number, Mass>();
  const seaMass = new Map<number, Mass>();
  const tiles = grid.provinceOfTile.length;

  for (let tile = 0; tile < tiles; tile++) {
    const x = tile % width;
    const y = (tile - x) / width;
    const province = grid.provinceOfTile[tile];
    if (province >= 0) {
      const zone = grid.provinces[province]?.airZone ?? -1;
      if (zone >= 0) accumulate(airMass, zone, x, y);
    }
    const sea = grid.seaZoneOfTile[tile];
    if (sea >= 0) accumulate(seaMass, sea, x, y);
  }

  const air = new Map<number, number>();
  const sea = new Map<number, number>();
  const best = new Map<number, number>();

  const consider = (
    out: Map<number, number>,
    mass: Map<number, Mass>,
    zone: number,
    tile: number,
    x: number,
    y: number,
  ): void => {
    const centre = mass.get(zone);
    if (centre === undefined) return;
    const dx = x - centre.x / centre.n;
    const dy = y - centre.y / centre.n;
    const distance = dx * dx + dy * dy;
    const key = zone * 2 + (out === sea ? 1 : 0);
    const closest = best.get(key);
    if (closest === undefined || distance < closest) {
      best.set(key, distance);
      out.set(zone, tile);
    }
  };

  for (let tile = 0; tile < tiles; tile++) {
    const x = tile % width;
    const y = (tile - x) / width;
    const province = grid.provinceOfTile[tile];
    if (province >= 0) {
      const zone = grid.provinces[province]?.airZone ?? -1;
      if (zone >= 0) consider(air, airMass, zone, tile, x, y);
    }
    const seaZone = grid.seaZoneOfTile[tile];
    if (seaZone >= 0) consider(sea, seaMass, seaZone, tile, x, y);
  }

  return { air, sea };
}
