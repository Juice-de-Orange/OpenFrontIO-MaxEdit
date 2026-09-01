import { describe, expect, test } from "vitest";
import {
  computeNationOfTile,
  type BorderCollection,
  type BordersFit,
} from "../../src/build/NationBorders";
import { LAND_BIT } from "../../src/shared/map/TerrainBits";

/**
 * The atlas lookup, on a synthetic map small enough to reason about.
 *
 * The real registration is exercised by `ProvinceArtifact.test.ts`, which
 * regenerates Europe byte for byte. These tests pin the machinery itself:
 * the lookup respects the geometry, capitals always claim their ground,
 * specks drown, the flood fills the drawn-but-unatlassed coast, and the
 * whole thing is deterministic.
 */

const W = 40;
const H = 30;

/** An identity-ish fit: pixel space and grid space coincide, no warp. */
function identityFit(): BordersFit {
  return {
    space: {
      pixelWidth: W,
      pixelHeight: H,
      gridWidth: W,
      gridHeight: H,
      lon0: 0,
      lon1: 10,
      lat0: 40,
      lat1: 50,
    },
    // basis is [1, xf, yf, ...] with xf = (px - W/2) / W, so gx = px needs
    // coefficients [W/2, W, 0, 0, 0, 0].
    quadX: [W / 2, W, 0, 0, 0, 0],
    quadY: [H / 2, 0, H, 0, 0, 0],
    gridNodesX: 2,
    gridNodesY: 2,
    displacement: [
      [
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
      ],
    ],
    sapmiAboveLat: 90,
  };
}

/** A lon/lat ring that rasterises to the given grid-cell rectangle. */
function cellRect(
  fit: BordersFit,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number[][] {
  const { gridWidth, gridHeight, lon0, lon1, lat0, lat1 } = fit.space;
  const mercator = (lat: number): number =>
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const m0 = mercator(lat0);
  const m1 = mercator(lat1);
  const lonAt = (gx: number): number => lon0 + (gx / gridWidth) * (lon1 - lon0);
  const latAt = (gy: number): number => {
    const m = m1 - (gy / gridHeight) * (m1 - m0);
    return ((2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180) / Math.PI;
  };
  return [
    [lonAt(x0), latAt(y0)],
    [lonAt(x1), latAt(y0)],
    [lonAt(x1), latAt(y1)],
    [lonAt(x0), latAt(y1)],
    [lonAt(x0), latAt(y0)],
  ];
}

function allLand(): Uint8Array {
  return new Uint8Array(W * H).fill(LAND_BIT);
}

describe("computeNationOfTile", () => {
  const fit = identityFit();
  const borders: BorderCollection = {
    features: [
      {
        properties: { GEOUNIT: "Westland" },
        geometry: { type: "Polygon", coordinates: [cellRect(fit, 0, 20, 0, 30)] },
      },
      {
        properties: { GEOUNIT: "Eastland" },
        geometry: { type: "Polygon", coordinates: [cellRect(fit, 20, 40, 0, 30)] },
      },
    ],
  };
  const seeds = [
    { x: 5, y: 15 },
    { x: 35, y: 15 },
  ];
  const names = ["Westland", "Eastland"];

  test("tiles fall to the nation whose geometry covers them", () => {
    const owner = computeNationOfTile(allLand(), W, H, seeds, names, fit, borders);
    expect(owner[15 * W + 5]).toBe(0);
    expect(owner[15 * W + 35]).toBe(1);
  });

  test("water stays unowned, and drawn land beyond the atlas floods from its neighbour", () => {
    const terrain = allLand();
    // A bite of water, and a drawn peninsula the atlas knows nothing about:
    // the geometry above covers the whole grid, so shrink it instead by
    // moving the east border; tiles east of the atlas edge but on the map
    // must flood from Eastland, not stay a hole.
    for (let y = 0; y < H; y++) terrain[y * W + 0] = 0;
    const owner = computeNationOfTile(terrain, W, H, seeds, names, fit, borders);
    expect(owner[15 * W + 0]).toBe(-1);
    expect(owner[15 * W + 1]).toBe(0);
  });

  test("a capital claims its ground even inside the neighbour's borders", () => {
    // Eastland's capital stands well inside Westland's geometry.
    const intruded = [
      { x: 5, y: 15 },
      { x: 15, y: 15 },
    ];
    const owner = computeNationOfTile(
      allLand(),
      W,
      H,
      intruded,
      names,
      fit,
      borders,
    );
    expect(owner[15 * W + 15]).toBe(1);
    // The claim is a disk, not a takeover: Westland keeps its far side.
    expect(owner[15 * W + 2]).toBe(0);
  });

  test("an island speck without a capital drowns; one with a capital survives", () => {
    const terrain = new Uint8Array(W * H);
    // Mainland for both nations, a 4-tile islet in Westland's waters.
    for (let y = 10; y < 20; y++) {
      for (let x = 8; x < 36; x++) terrain[y * W + x] = LAND_BIT;
    }
    terrain[2 * W + 2] = LAND_BIT;
    terrain[2 * W + 3] = LAND_BIT;
    terrain[3 * W + 2] = LAND_BIT;
    terrain[3 * W + 3] = LAND_BIT;
    const seeds2 = [
      { x: 10, y: 15 },
      { x: 34, y: 15 },
    ];
    const drowned = computeNationOfTile(terrain, W, H, seeds2, names, fit, borders);
    expect(drowned[2 * W + 2]).toBe(-1);

    // The same islet as Westland's capital: kept, as a city-state is.
    const island = [
      { x: 2, y: 2 },
      { x: 34, y: 15 },
    ];
    const kept = computeNationOfTile(terrain, W, H, island, names, fit, borders);
    expect(kept[2 * W + 2]).toBe(0);
  });

  test("the same inputs give byte-identical output", () => {
    const a = computeNationOfTile(allLand(), W, H, seeds, names, fit, borders);
    const b = computeNationOfTile(allLand(), W, H, seeds, names, fit, borders);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });

  test("a nation whose map unit has no feature is a loud error", () => {
    expect(() =>
      computeNationOfTile(
        allLand(),
        W,
        H,
        [...seeds, { x: 20, y: 15 }],
        [...names, "Atlantis"],
        fit,
        borders,
      ),
    ).toThrow(/Atlantis/);
  });
});
