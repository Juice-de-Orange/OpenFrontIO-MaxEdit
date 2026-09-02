import { describe, expect, test } from "vitest";
import { zoneAnchors } from "../../../src/client/world/ZoneAnchors";

/**
 * The point an area gets, so a wing or a fleet has somewhere to stand.
 */
describe("zone anchors", () => {
  /**
   * A 6x4 grid. The left half is land in air zone 0, the right half water in
   * sea zone 1, with one land column between them in air zone 2.
   */
  function grid() {
    const width = 6;
    const height = 4;
    const provinceOfTile = new Int32Array(width * height).fill(-1);
    const seaZoneOfTile = new Int32Array(width * height).fill(-1);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tile = y * width + x;
        if (x < 2) provinceOfTile[tile] = 0;
        else if (x === 2) provinceOfTile[tile] = 1;
        else seaZoneOfTile[tile] = 1;
      }
    }
    return {
      grid: {
        provinceOfTile,
        seaZoneOfTile,
        provinces: [{ airZone: 0 }, { airZone: 2 }] as unknown as ReturnType<
          typeof Object
        >[],
      },
      width,
    };
  }

  test("each zone gets one tile, and it belongs to that zone", () => {
    const { grid: g, width } = grid();
    const anchors = zoneAnchors(g as never, width);
    expect(anchors.air.size).toBe(2);
    expect(anchors.sea.size).toBe(1);

    const airTile = anchors.air.get(0) as number;
    expect(g.provinceOfTile[airTile]).toBe(0);
    const seaTile = anchors.sea.get(1) as number;
    expect(g.seaZoneOfTile[seaTile]).toBe(1);
  });

  test("the tile is near the zone's middle, not on its edge", () => {
    const { grid: g, width } = grid();
    const anchors = zoneAnchors(g as never, width);
    // Sea zone 1 spans x 3..5, y 0..3: its middle is x 4, y 1.5.
    const tile = anchors.sea.get(1) as number;
    const x = tile % width;
    const y = (tile - x) / width;
    expect(x).toBe(4);
    expect(y === 1 || y === 2).toBe(true);
  });

  test("a map with no water has no sea anchors and does not throw", () => {
    const width = 3;
    const provinceOfTile = new Int32Array(9).fill(0);
    const seaZoneOfTile = new Int32Array(9).fill(-1);
    const anchors = zoneAnchors(
      { provinceOfTile, seaZoneOfTile, provinces: [{ airZone: 4 }] } as never,
      width,
    );
    expect(anchors.sea.size).toBe(0);
    expect(anchors.air.get(4)).toBeDefined();
  });
});
