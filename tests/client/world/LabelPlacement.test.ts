import { describe, expect, test } from "vitest";
import {
  findLargestInscribedRectangle,
  fontSizeFor,
  largestRectangleInHistogram,
  placeLabel,
  scaleFor,
} from "../../../src/client/world/LabelPlacement";

/**
 * The label search, against grids drawn by hand.
 *
 * Every case here is a shape the old rule — "the centre of the largest
 * province" — put the name in the wrong place on: a horseshoe, a coastline,
 * a long thin country.
 */

/** `#` is inside, anything else is out. Rows read top to bottom. */
function grid(...rows: string[]): boolean[][] {
  const cols = rows[0].length;
  const out: boolean[][] = [];
  for (let col = 0; col < cols; col++) {
    out.push(rows.map((row) => row[col] === "#"));
  }
  return out;
}

describe("the largest rectangle in a histogram", () => {
  test("the classic case", () => {
    // Heights 2,1,5,6,2,3: the answer is the 5,6 pair, ten cells.
    const rect = largestRectangleInHistogram([2, 1, 5, 6, 2, 3]);
    expect(rect.width * rect.height).toBe(10);
    expect(rect).toMatchObject({ x: 2, width: 2, height: 5 });
  });

  test("a flat run is the whole run", () => {
    const rect = largestRectangleInHistogram([3, 3, 3, 3]);
    expect(rect).toMatchObject({ x: 0, width: 4, height: 3 });
  });

  test("nothing is nothing", () => {
    expect(largestRectangleInHistogram([0, 0, 0])).toMatchObject({
      width: 0,
      height: 0,
    });
  });
});

describe("the largest rectangle inscribed in a shape", () => {
  test("a solid block is itself", () => {
    const rect = findLargestInscribedRectangle(grid("####", "####", "####"));
    expect(rect).toMatchObject({ x: 0, y: 0, width: 4, height: 3 });
  });

  test("a horseshoe: the answer is a leg, never the hole", () => {
    const rect = findLargestInscribedRectangle(
      grid("##....##", "##....##", "##....##", "########", "########"),
    );
    // Four cells wide only across the foot; the biggest is the 8x2 foot.
    expect(rect.width * rect.height).toBe(16);
    expect(rect).toMatchObject({ y: 3, width: 8, height: 2 });
  });

  test("a long thin country gets a long thin rectangle", () => {
    const rect = findLargestInscribedRectangle(
      grid("##########", "##########"),
    );
    expect(rect).toMatchObject({ width: 10, height: 2 });
  });

  test("a shape with no room at all", () => {
    expect(findLargestInscribedRectangle(grid("....", "...."))).toMatchObject({
      width: 0,
      height: 0,
    });
  });
});

describe("the font size", () => {
  test("is the tighter of the two constraints", () => {
    // Wide and shallow: the height decides.
    expect(fontSizeFor({ x: 0, y: 0, width: 100, height: 9 }, 4)).toBe(3);
    // Tall and narrow with a long name: the width decides.
    expect(fontSizeFor({ x: 0, y: 0, width: 10, height: 90 }, 10)).toBe(2);
  });
});

describe("the grid is coarser for bigger nations", () => {
  test("the ladder upstream drew", () => {
    const box = (size: number) => ({
      minX: 0,
      minY: 0,
      maxX: size,
      maxY: size,
    });
    expect(scaleFor(box(10))).toBe(1);
    expect(scaleFor(box(30))).toBe(2);
    expect(scaleFor(box(60))).toBe(4);
    expect(scaleFor(box(120))).toBe(8);
    expect(scaleFor(box(300))).toBe(16);
    expect(scaleFor(box(600))).toBe(32);
  });
});

describe("placing a name", () => {
  /** A ring of land with a hole in the middle, at tile resolution. */
  const ring = (x: number, y: number): boolean => {
    const inSquare = x >= 0 && x < 20 && y >= 0 && y < 20;
    const inHole = x >= 6 && x < 14 && y >= 6 && y < 14;
    return inSquare && !inHole;
  };

  test("the name lands on land, not in the hole", () => {
    const label = placeLabel({
      box: { minX: 0, minY: 0, maxX: 19, maxY: 19 },
      inside: ring,
      nameLength: 6,
      minSize: 2,
      maxSize: 40,
    });
    expect(label).not.toBeNull();
    if (label === null) return;
    // The anchor is lifted by a third of the size, so the point itself may
    // sit above the band; what must hold is that the band it names is land.
    expect(ring(label.x, label.y + label.size / 3)).toBe(true);
    expect(label.size).toBeGreaterThanOrEqual(2);
  });

  test("an empty box places nothing", () => {
    expect(
      placeLabel({
        box: { minX: 0, minY: 0, maxX: 9, maxY: 9 },
        inside: () => false,
        nameLength: 4,
        minSize: 2,
        maxSize: 40,
      }),
    ).toBeNull();
  });

  test("a size is clamped to what the map can read", () => {
    const label = placeLabel({
      box: { minX: 0, minY: 0, maxX: 400, maxY: 400 },
      inside: () => true,
      nameLength: 3,
      minSize: 6,
      maxSize: 40,
    });
    expect(label?.size).toBe(40);
  });
});
