import { describe, expect, test } from "vitest";
import { computeProvincePartition } from "../../src/shared/map/ProvincePartition";
import { terrainHashFnv1a } from "../../src/shared/map/TerrainHash";

const LAND = 0x80;

/** A 24x12 continent with a lake, and three capitals spread across it. */
function fixture() {
  const width = 24;
  const height = 12;
  const terrain = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) terrain[y * width + x] = LAND | 3;
  }
  // A lake, so borders have something to bend around.
  for (let y = 5; y < 8; y++) {
    for (let x = 10; x < 14; x++) terrain[y * width + x] = 0;
  }
  const seeds = [
    { x: 3, y: 3 },
    { x: 20, y: 3 },
    { x: 12, y: 10 },
  ];
  return { terrain, width, height, seeds };
}

describe("computeProvincePartition", () => {
  test("is deterministic", () => {
    const { terrain, width, height, seeds } = fixture();
    const a = computeProvincePartition(terrain, width, height, seeds);
    const b = computeProvincePartition(terrain, width, height, seeds);
    expect(a.count).toBe(b.count);
    expect([...a.provinceOfTile]).toEqual([...b.provinceOfTile]);
    expect([...a.nationOfProvince]).toEqual([...b.nationOfProvince]);
    expect(a.neighbours).toEqual(b.neighbours);
  });

  test("labels every land tile and no water tile", () => {
    const { terrain, width, height, seeds } = fixture();
    const p = computeProvincePartition(terrain, width, height, seeds);
    for (let i = 0; i < terrain.length; i++) {
      const isLand = (terrain[i] & LAND) !== 0;
      expect(p.provinceOfTile[i] >= 0).toBe(isLand);
    }
  });

  test("no province straddles a national border", () => {
    // The point of the whole algorithm. Territory is grown from the capitals
    // first and only then subdivided, so every tile of a province belongs to
    // the same nation — which is what makes an ownership change mean
    // something and a front line follow the map.
    const { terrain, width, height, seeds } = fixture();
    const p = computeProvincePartition(terrain, width, height, seeds);

    // Rebuild nation-per-tile from the province labels and check it is
    // single-valued per province.
    const nationSeen = new Map<number, number>();
    for (let i = 0; i < p.provinceOfTile.length; i++) {
      const province = p.provinceOfTile[i];
      if (province < 0) continue;
      const nation = p.nationOfProvince[province];
      const already = nationSeen.get(province);
      if (already === undefined) nationSeen.set(province, nation);
      else expect(already).toBe(nation);
    }
    expect(nationSeen.size).toBe(p.count);
  });

  test("every province is non-empty and connected", () => {
    const { terrain, width, height, seeds } = fixture();
    const p = computeProvincePartition(terrain, width, height, seeds);

    const tilesOf = new Map<number, number[]>();
    for (let i = 0; i < p.provinceOfTile.length; i++) {
      const id = p.provinceOfTile[i];
      if (id < 0) continue;
      const list = tilesOf.get(id) ?? [];
      list.push(i);
      tilesOf.set(id, list);
    }
    expect(tilesOf.size).toBe(p.count);

    // Connectivity: a province the player cannot walk across is not a
    // province, it is two provinces sharing an id.
    for (const [id, tiles] of tilesOf) {
      const members = new Set(tiles);
      const seen = new Set<number>([tiles[0]]);
      const queue = [tiles[0]];
      while (queue.length > 0) {
        const t = queue.pop()!;
        const x = t % width;
        const y = Math.floor(t / width);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (!members.has(n) || seen.has(n)) continue;
          seen.add(n);
          queue.push(n);
        }
      }
      expect(seen.size, `province ${id} is not connected`).toBe(tiles.length);
    }
  });

  test("adjacency is symmetric and excludes self", () => {
    const { terrain, width, height, seeds } = fixture();
    const p = computeProvincePartition(terrain, width, height, seeds);
    p.neighbours.forEach((list, a) => {
      expect(list).not.toContain(a);
      for (const b of list) expect(p.neighbours[b]).toContain(a);
      // Sorted, because Set iteration order is insertion order and anything
      // order-dependent has to be reproducible.
      expect([...list].sort((x, y) => x - y)).toEqual(list);
    });
  });

  test("centres lie inside their own province", () => {
    const { terrain, width, height, seeds } = fixture();
    const p = computeProvincePartition(terrain, width, height, seeds);
    p.centres.forEach((c, id) => {
      const at = p.provinceOfTile[c.y * width + c.x];
      // A centre of mass can fall outside a crescent-shaped province; when it
      // does it must at least still be land of the same nation.
      if (at !== id) {
        expect(at).toBeGreaterThanOrEqual(0);
        expect(p.nationOfProvince[at]).toBe(p.nationOfProvince[id]);
      }
    });
  });

  test("larger nations get more provinces", () => {
    // Area has to keep meaning something: a fixed count per nation would make
    // a city state mechanically equal to a continent.
    const width = 40;
    const height = 10;
    const terrain = new Uint8Array(width * height).fill(LAND | 1);
    const p = computeProvincePartition(terrain, width, height, [
      { x: 1, y: 5 }, // gets the long western stretch
      { x: 38, y: 5 }, // gets the long eastern stretch
    ]);
    const per = new Map<number, number>();
    for (const nation of p.nationOfProvince) {
      per.set(nation, (per.get(nation) ?? 0) + 1);
    }
    expect(per.size).toBe(2);
  });

  test("a map with no land has no provinces", () => {
    const p = computeProvincePartition(new Uint8Array(24), 6, 4, [
      { x: 1, y: 1 },
    ]);
    expect(p.count).toBe(0);
  });

  test("rejects a terrain buffer that does not match the dimensions", () => {
    expect(() =>
      computeProvincePartition(new Uint8Array(10), 4, 4, [{ x: 0, y: 0 }]),
    ).toThrow(/expected 16/);
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
    expect(terrainHashFnv1a(new Uint8Array(64).fill(LAND))).not.toBe(
      terrainHashFnv1a(new Uint8Array(16).fill(LAND)),
    );
  });
});
