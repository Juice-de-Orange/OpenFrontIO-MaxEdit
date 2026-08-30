import { describe, expect, test } from "vitest";
import {
  computeProvinceGrid,
  terrainHashFnv1a,
} from "../../src/shared/map/ProvinceGrid";

const LAND = 0x80;

/** A 10x6 map: land in a blob on the left, water on the right. */
function fixture(): { terrain: Uint8Array; width: number; height: number } {
  const width = 10;
  const height = 6;
  const terrain = new Uint8Array(width * height);
  for (let y = 1; y < 5; y++) {
    for (let x = 1; x < 5; x++) {
      terrain[y * width + x] = LAND | 3;
    }
  }
  return { terrain, width, height };
}

describe("computeProvinceGrid", () => {
  test("is deterministic", () => {
    const { terrain, width, height } = fixture();
    const a = computeProvinceGrid(terrain, width, height, 2);
    const b = computeProvinceGrid(terrain, width, height, 2);
    expect(a.count).toBe(b.count);
    expect(Array.from(a.provinceOfTile)).toEqual(Array.from(b.provinceOfTile));
    expect(a.centres).toEqual(b.centres);
  });

  test("labels every land tile and no water tile", () => {
    const { terrain, width, height } = fixture();
    const grid = computeProvinceGrid(terrain, width, height, 2);
    for (let i = 0; i < terrain.length; i++) {
      const isLand = (terrain[i] & LAND) !== 0;
      expect(grid.provinceOfTile[i] >= 0).toBe(isLand);
    }
  });

  test("every province is non-empty, and ids are dense", () => {
    const { terrain, width, height } = fixture();
    const grid = computeProvinceGrid(terrain, width, height, 2);
    const tilesPer = new Map<number, number>();
    for (const id of grid.provinceOfTile) {
      if (id < 0) continue;
      tilesPer.set(id, (tilesPer.get(id) ?? 0) + 1);
    }
    expect(tilesPer.size).toBe(grid.count);
    for (let id = 0; id < grid.count; id++) {
      // A cell with no land must not become a province — phase 2's generator
      // has to hold the same invariant, and an empty province would produce
      // ownership nobody can see or take.
      expect(tilesPer.get(id) ?? 0).toBeGreaterThan(0);
    }
    expect(grid.centres).toHaveLength(grid.count);
  });

  test("centres sit inside their own province", () => {
    const { terrain, width, height } = fixture();
    const grid = computeProvinceGrid(terrain, width, height, 2);
    grid.centres.forEach((c, id) => {
      expect(grid.provinceOfTile[c.y * width + c.x]).toBe(id);
    });
  });

  test("a map with no land has no provinces", () => {
    const grid = computeProvinceGrid(new Uint8Array(24), 6, 4, 2);
    expect(grid.count).toBe(0);
    expect(grid.centres).toEqual([]);
  });

  test("rejects a terrain buffer that does not match the dimensions", () => {
    expect(() => computeProvinceGrid(new Uint8Array(10), 4, 4)).toThrow(
      /expected 16/,
    );
  });
});

describe("terrainHashFnv1a", () => {
  test("is stable and unsigned", () => {
    const { terrain } = fixture();
    const h = terrainHashFnv1a(terrain);
    expect(h).toBe(terrainHashFnv1a(terrain));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h)).toBe(true);
  });

  test("changes when a single byte changes", () => {
    const { terrain } = fixture();
    const before = terrainHashFnv1a(terrain);
    const changed = Uint8Array.from(terrain);
    changed[0] ^= 0x01;
    expect(terrainHashFnv1a(changed)).not.toBe(before);
  });

  test("distinguishes the two map resolutions it exists to distinguish", () => {
    // The failure this guards: one side loading map.bin, the other map4x.bin.
    const full = new Uint8Array(64).fill(LAND);
    const quarter = new Uint8Array(16).fill(LAND);
    expect(terrainHashFnv1a(full)).not.toBe(terrainHashFnv1a(quarter));
  });
});
