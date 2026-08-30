import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  generateProvinceMap,
  serialiseProvinceMeta,
  type GeneratorManifest,
} from "../../src/build/GenerateProvinceMap";
import type { Resource } from "../../src/shared/config/provinces";
import {
  AIR_ZONE_MAX_PROVINCES,
  AIR_ZONE_MIN_PROVINCES,
  BUILDING_SLOTS_MAX,
  BUILDING_SLOTS_MIN,
  INFRASTRUCTURE_MAX,
  INFRASTRUCTURE_MIN,
  RESOURCES,
} from "../../src/shared/config/provinces";
import {
  computeBorderTiles,
  decodeProvinceMap,
  type ProvinceMap,
  type ProvinceMapMeta,
} from "../../src/shared/map/ProvinceMap";
import { TerrainType } from "../../src/shared/map/Terrain";

const MAP_ID = "europe";
const DIR = path.resolve(__dirname, "../../resources/maps", MAP_ID);

function read(file: string): Buffer {
  return fs.readFileSync(path.join(DIR, file));
}

describe("the checked-in province artefact", () => {
  let manifest: GeneratorManifest;
  let terrain: Uint8Array;
  let regenerated: ReturnType<typeof generateProvinceMap>;
  let loaded: ProvinceMap;

  beforeAll(() => {
    manifest = JSON.parse(
      read("manifest.json").toString("utf-8"),
    ) as GeneratorManifest;
    terrain = new Uint8Array(read("map4x.bin"));
    regenerated = generateProvinceMap(MAP_ID, manifest, terrain);
    loaded = decodeProvinceMap(
      new Uint8Array(read("provinces.bin")),
      JSON.parse(read("provinces.json").toString("utf-8")) as ProvinceMapMeta,
    );
  });

  /**
   * The one that matters.
   *
   * The partition and the attribute rules are now map data a running season
   * stands on: a change to either has to come with a regenerated artefact in
   * the same commit, or the world silently starts meaning something else by
   * every province id in its command log. This test is what makes that
   * impossible to forget — it goes red the moment the generator and the file
   * disagree, and `npm run gen-provinces` is the fix.
   */
  test("is exactly what the generator produces today", () => {
    expect(Buffer.from(regenerated.bin).equals(read("provinces.bin"))).toBe(
      true,
    );
    expect(serialiseProvinceMeta(regenerated.meta)).toBe(
      read("provinces.json").toString("utf-8"),
    );
  });

  test("generates identically twice over", () => {
    const again = generateProvinceMap(MAP_ID, manifest, terrain);
    expect(Buffer.from(again.bin).equals(Buffer.from(regenerated.bin))).toBe(
      true,
    );
    expect(again.meta.partitionHash).toBe(regenerated.meta.partitionHash);
  });

  test("decodes back to the tile assignment it was written from", () => {
    expect(loaded.provinceCount).toBe(regenerated.meta.provinceCount);
    expect(loaded.partitionHash).toBe(regenerated.meta.partitionHash);
    expect(loaded.provinceOfTile.length).toBe(loaded.width * loaded.height);

    // One assertion for 1.2 million tiles, not 1.2 million assertions: the
    // first version of this test called expect() per tile and timed out.
    let land = 0;
    let water = 0;
    let outOfRange = 0;
    let landWithSeaZone = 0;
    for (let i = 0; i < loaded.provinceOfTile.length; i++) {
      const province = loaded.provinceOfTile[i];
      if (province >= 0) {
        if (province >= loaded.provinceCount) outOfRange++;
        if (loaded.seaZoneOfTile[i] !== -1) landWithSeaZone++;
        land++;
      } else {
        if (loaded.seaZoneOfTile[i] >= loaded.seaZoneCount) outOfRange++;
        water++;
      }
    }
    expect(outOfRange).toBe(0);
    expect(landWithSeaZone).toBe(0);
    expect(land).toBeGreaterThan(0);
    expect(water).toBeGreaterThan(0);
  });

  test("lands in the 300-800 provinces the specification asks for", () => {
    expect(loaded.provinceCount).toBeGreaterThanOrEqual(300);
    expect(loaded.provinceCount).toBeLessThanOrEqual(800);
  });
});

describe("derived province attributes", () => {
  let loaded: ProvinceMap;

  beforeAll(() => {
    loaded = decodeProvinceMap(
      new Uint8Array(read("provinces.bin")),
      JSON.parse(read("provinces.json").toString("utf-8")) as ProvinceMapMeta,
    );
  });

  test("every province is inside its declared ranges", () => {
    for (const province of loaded.provinces) {
      expect(province.infrastructure).toBeGreaterThanOrEqual(
        INFRASTRUCTURE_MIN,
      );
      expect(province.infrastructure).toBeLessThanOrEqual(INFRASTRUCTURE_MAX);
      expect(province.buildingSlots).toBeGreaterThanOrEqual(BUILDING_SLOTS_MIN);
      expect(province.buildingSlots).toBeLessThanOrEqual(BUILDING_SLOTS_MAX);
      expect(province.tileCount).toBeGreaterThan(0);
      expect(province.nation).toBeGreaterThan(0);
      expect([
        TerrainType.Plains,
        TerrainType.Highland,
        TerrainType.Mountain,
      ]).toContain(province.terrain);
    }
  });

  test("neighbour lists are symmetric and never name the province itself", () => {
    for (const province of loaded.provinces) {
      for (const neighbour of province.neighbours) {
        expect(neighbour).not.toBe(province.id);
        expect(loaded.provinces[neighbour].neighbours).toContain(province.id);
      }
    }
  });

  test("every province is in exactly one air zone, and every zone is used", () => {
    const seen = new Set<number>();
    for (const province of loaded.provinces) {
      expect(province.airZone).toBeGreaterThanOrEqual(0);
      expect(province.airZone).toBeLessThan(loaded.airZoneCount);
      seen.add(province.airZone);
    }
    expect(seen.size).toBe(loaded.airZoneCount);
  });

  /**
   * Zones are grown by breadth-first search and merged only into an adjacent
   * zone, so every one of them is connected by construction. Asserting it
   * anyway is what catches a merge that hands provinces to a zone that is no
   * longer there — which is exactly what the first version of the merge did.
   */
  test("every air zone is one connected group of provinces", () => {
    const byZone = new Map<number, number[]>();
    for (const province of loaded.provinces) {
      const list = byZone.get(province.airZone) ?? [];
      list.push(province.id);
      byZone.set(province.airZone, list);
    }

    for (const [zone, members] of byZone) {
      const inZone = new Set(members);
      const seen = new Set<number>([members[0]]);
      const queue = [members[0]];
      for (let head = 0; head < queue.length; head++) {
        for (const neighbour of loaded.provinces[queue[head]].neighbours) {
          if (!inZone.has(neighbour) || seen.has(neighbour)) continue;
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
      expect(seen.size, `air zone ${zone} is in pieces`).toBe(members.length);
    }
  });

  test("air zones come out the size the generator promises", () => {
    const sizes = new Map<number, number>();
    for (const province of loaded.provinces) {
      sizes.set(province.airZone, (sizes.get(province.airZone) ?? 0) + 1);
    }
    const all = [...sizes.values()];
    // The maximum is the hard one: a zone well over it stops being one air
    // theatre, and it is the shape the earlier distance-based flood produced.
    expect(Math.max(...all)).toBeLessThanOrEqual(AIR_ZONE_MAX_PROVINCES);
    // Islands are allowed under the minimum; most zones are not.
    const small = all.filter((size) => size < AIR_ZONE_MIN_PROVINCES).length;
    expect(small).toBeLessThan(all.length / 3);
  });

  test("a sea zone is only assigned to a coastal province", () => {
    for (const province of loaded.provinces) {
      if (province.seaZone === null) continue;
      expect(province.coastal, `province ${province.id}`).toBe(true);
      expect(province.seaZone).toBeGreaterThanOrEqual(0);
      expect(province.seaZone).toBeLessThan(loaded.seaZoneCount);
    }
  });

  test("deposits are whole positive amounts of the four resources", () => {
    const found = new Set<Resource>();
    for (const province of loaded.provinces) {
      for (const [resource, amount] of Object.entries(
        province.resourceDeposits,
      )) {
        expect(RESOURCES).toContain(resource);
        expect(Number.isInteger(amount)).toBe(true);
        expect(amount).toBeGreaterThan(0);
        found.add(resource as Resource);
      }
    }
    // All four have to appear somewhere, or a nation can never be short of
    // one and §6.5's trade has nothing to trade.
    expect([...found].sort()).toEqual([...RESOURCES].sort());
  });

  test("no nation is self-sufficient in everything", () => {
    const byNation = new Map<number, Set<string>>();
    for (const province of loaded.provinces) {
      const have = byNation.get(province.nation) ?? new Set<string>();
      for (const resource of Object.keys(province.resourceDeposits)) {
        have.add(resource);
      }
      byNation.set(province.nation, have);
    }
    const complete = [...byNation.values()].filter(
      (have) => have.size === RESOURCES.length,
    );
    // Some large nations will have all four; most must not, or the economy
    // has no shape and trade is decoration.
    expect(complete.length).toBeLessThan(byNation.size / 2);
  });
});

describe("the border mask", () => {
  test("marks exactly the land tiles that touch another land province", () => {
    // A 4x2 strip: provinces 0 | 1, with water in the last column.
    const width = 4;
    const height = 2;
    const provinceOfTile = Int32Array.from([0, 0, 1, -1, 0, 0, 1, -1]);
    const border = computeBorderTiles(provinceOfTile, width, height);
    expect([...border]).toEqual([0, 1, 1, 0, 0, 1, 1, 0]);
  });

  test("leaves a coastline alone", () => {
    const provinceOfTile = Int32Array.from([0, 0, -1, -1]);
    expect([...computeBorderTiles(provinceOfTile, 4, 1)]).toEqual([0, 0, 0, 0]);
  });
});
