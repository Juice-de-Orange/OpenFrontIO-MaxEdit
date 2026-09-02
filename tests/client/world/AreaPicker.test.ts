import { describe, expect, test } from "vitest";
import { zoneUnder } from "../../../src/client/world/AreaPicker";

/**
 * A box drawn on the map, read as the zone it mostly covers.
 */
function grid() {
  const width = 8;
  const height = 8;
  const provinceOfTile = new Int32Array(width * height).fill(-1);
  const seaZoneOfTile = new Int32Array(width * height).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = y * width + x;
      // Left half is land in air zone 5; right half is water, split into sea
      // zone 1 (top) and sea zone 2 (bottom).
      if (x < 4) provinceOfTile[tile] = 0;
      else seaZoneOfTile[tile] = y < 4 ? 1 : 2;
    }
  }
  return {
    grid: { provinceOfTile, seaZoneOfTile, provinces: [{ airZone: 5 }] },
    width,
    height,
  };
}

describe("the water a drawn box means", () => {
  const { grid: g, width, height } = grid();
  const pick = (box: Parameters<typeof zoneUnder>[3], kind: "air" | "naval") =>
    zoneUnder(g as never, width, height, box, kind);

  test("a box over one sea zone is that zone", () => {
    expect(pick({ x0: 4, y0: 0, x1: 7, y1: 3 }, "naval")).toBe(1);
    expect(pick({ x0: 4, y0: 4, x1: 7, y1: 7 }, "naval")).toBe(2);
  });

  test("a box across two takes the one it caught most of", () => {
    // Three rows of zone 1, one of zone 2.
    expect(pick({ x0: 4, y0: 1, x1: 7, y1: 4 }, "naval")).toBe(1);
    // And the other way round.
    expect(pick({ x0: 4, y0: 3, x1: 7, y1: 6 }, "naval")).toBe(2);
  });

  test("a box over land means nothing to a fleet", () => {
    expect(pick({ x0: 0, y0: 0, x1: 3, y1: 3 }, "naval")).toBeNull();
  });

  test("and everything to a wing, which reads the air zones instead", () => {
    expect(pick({ x0: 0, y0: 0, x1: 3, y1: 3 }, "air")).toBe(5);
    expect(pick({ x0: 4, y0: 0, x1: 7, y1: 3 }, "air")).toBeNull();
  });

  test("a stray click is not a drawing", () => {
    expect(pick({ x0: 4, y0: 0, x1: 4, y1: 0 }, "naval")).toBeNull();
  });

  test("a box off the edge of the map is clamped, not crashed", () => {
    expect(pick({ x0: -50, y0: -50, x1: 3, y1: 3 }, "air")).toBe(5);
    expect(pick({ x0: 100, y0: 100, x1: 200, y1: 200 }, "naval")).toBeNull();
  });
});
