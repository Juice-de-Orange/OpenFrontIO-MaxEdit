import { describe, expect, test } from "vitest";
import {
  airZoneOfTile,
  zoneBorderMasks,
  zoneLayerPixels,
} from "../../../src/client/world/ZoneBorders";
import type { Province } from "../../../src/shared/map/Province";
import { TerrainType } from "../../../src/shared/map/Terrain";

/**
 * Zone borders on the map. What is checkable without a GPU is the mask: a
 * seam where two provinces in different air zones meet, nothing inside a
 * zone, and sea-zone seams only on water — the layers are placed on land and
 * water respectively, and a tile in the wrong one is discarded anyway.
 */
function province(id: number, airZone: number): Province {
  return {
    id,
    nation: 1,
    neighbours: [],
    airZone,
    seaZone: null,
    terrain: TerrainType.Plains,
    infrastructure: 0,
    buildingSlots: 1,
    resourceDeposits: {},
    tileCount: 1,
    centre: { x: id, y: 0 },
    coastal: false,
    capital: false,
  };
}

describe("zone border masks", () => {
  // Four land tiles then two water tiles in a row: provinces 0,0 | 1 | 2 on
  // land (zones 5,5,7), sea zones 3 | 4 on the water.
  const grid = {
    provinceOfTile: Int32Array.from([0, 0, 1, 2, -1, -1]),
    seaZoneOfTile: Int32Array.from([-1, -1, -1, -1, 3, 4]),
    provinces: [province(0, 5), province(1, 5), province(2, 7)],
  };

  test("the air zone of a tile is its province's, and water has none", () => {
    expect([...airZoneOfTile(grid)]).toEqual([5, 5, 5, 7, -1, -1]);
  });

  test("a seam only where the air zone changes — not at every province edge", () => {
    const { air } = zoneBorderMasks(grid, 6, 1);
    // Provinces 0 and 1 share zone 5: no seam between tiles 1 and 2. Zone 7
    // begins at tile 3.
    expect([...air]).toEqual([0, 0, 1, 1, 0, 0]);
  });

  test("sea-zone seams lie on water and nowhere else", () => {
    const { sea } = zoneBorderMasks(grid, 6, 1);
    expect([...sea]).toEqual([0, 0, 0, 0, 1, 1]);
  });

  test("the image is coloured on a seam and genuinely zero elsewhere", () => {
    const image = zoneLayerPixels(
      Uint8Array.from([0, 1]),
      2,
      1,
      [120, 180, 255, 190],
    );
    expect([...image.data]).toEqual([0, 0, 0, 0, 120, 180, 255, 190]);
    expect(() =>
      zoneLayerPixels(new Uint8Array(3), 2, 2, [0, 0, 0, 0]),
    ).toThrow(/expected 4/);
  });
});
