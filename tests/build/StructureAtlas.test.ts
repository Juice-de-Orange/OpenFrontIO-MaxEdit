import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  STRUCTURE_ORDER,
  STRUCTURE_SHAPE,
} from "../../src/client/render/types/UnitType";

/**
 * The atlas and the table that indexes it move together. The passes read the
 * PNG as `STRUCTURE_ORDER.length` equal 64-pixel columns; a column added to
 * the list without a run of `npm run gen-structure-atlas` would sample the
 * neighbour's icon, and the other way round nothing would draw the new one.
 * The PNG header is enough to check: width and height sit at fixed offsets.
 */
describe("the structure icon atlas", () => {
  test("has one 64-pixel column per structure type, in one row", () => {
    const png = readFileSync("resources/atlases/icon-atlas.png");
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(height).toBe(64);
    expect(width).toBe(64 * STRUCTURE_ORDER.length);
  });

  test("every column has a plate shape the shader knows", () => {
    for (const type of STRUCTURE_ORDER) {
      const shape = STRUCTURE_SHAPE[type];
      expect(shape).toBeGreaterThanOrEqual(0);
      expect(shape).toBeLessThanOrEqual(5);
    }
  });
});
