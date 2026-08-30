import { describe, expect, test } from "vitest";
import { borderLayerPixels } from "../../../src/client/world/ProvinceBorders";
import { computeBorderTiles } from "../../../src/shared/map/ProvinceMap";

describe("the province border layer image", () => {
  test("is opaque on a border tile and fully transparent elsewhere", () => {
    // Two provinces side by side, with water on the right.
    const provinceOfTile = Int32Array.from([0, 0, 1, -1]);
    const border = computeBorderTiles(provinceOfTile, 4, 1);
    const image = borderLayerPixels(border, 4, 1);

    const alpha = [0, 1, 2, 3].map((tile) => image.data[tile * 4 + 3]);
    // Tiles 1 and 2 straddle the province edge; tile 0 is interior and tile 3
    // is water.
    expect(alpha[0]).toBe(0);
    expect(alpha[1]).toBeGreaterThan(0);
    expect(alpha[2]).toBeGreaterThan(0);
    expect(alpha[3]).toBe(0);
  });

  /**
   * The shader discards anything under alpha 0.01, so a non-border pixel has
   * to be genuinely zero rather than merely dark. A buffer that was filled
   * with a background colour first would draw the whole map.
   */
  test("leaves every channel at zero away from a border", () => {
    const image = borderLayerPixels(new Uint8Array(4), 2, 2);
    expect([...image.data].every((channel) => channel === 0)).toBe(true);
  });

  test("refuses a mask that is not the size of the map", () => {
    expect(() => borderLayerPixels(new Uint8Array(3), 2, 2)).toThrow(
      /expected 4/,
    );
  });
});
