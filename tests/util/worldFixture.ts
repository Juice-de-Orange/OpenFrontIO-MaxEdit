/**
 * A synthetic map, run through the real province generator.
 *
 * The world no longer partitions anything at startup — it loads an artefact
 * (docs/decisions/0006). A test that built a `ProvincePartition` by hand would
 * be testing a shape the world never sees, so these fixtures make terrain and
 * push it through `generateProvinceMap`, exactly as `npm run gen-provinces`
 * does for Europe.
 *
 * **Fixtures have to be big.** Provinces are cut at roughly 900 tiles, so a
 * small map gives each nation one province, every "does this border mine"
 * question is then vacuously true or impossible, and the border drift eats the
 * world inside thirty ticks.
 */

import { generateProvinceMap } from "../../src/build/GenerateProvinceMap";
import {
  decodeProvinceMap,
  type ProvinceMap,
} from "../../src/shared/map/ProvinceMap";
import type {
  MapDescriptor,
  NationStatic,
} from "../../src/shared/protocol/Wire";

const LAND = 0x80;

export interface FixtureOptions {
  id?: string;
  width: number;
  height: number;
  /** Capital positions in tile space, one per nation. */
  capitals: { x: number; y: number }[];
}

export interface Fixture {
  map: ProvinceMap;
  descriptor: MapDescriptor;
  nations: NationStatic[];
}

/** A rectangle of land with a one-tile ocean margin, cut into provinces. */
export function mapFixture(options: FixtureOptions): Fixture {
  const { width, height, capitals } = options;
  const id = options.id ?? "fixture";

  const terrain = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) terrain[y * width + x] = LAND | 3;
  }

  // The generator scales capitals from full-map coordinates to map4x, so a
  // manifest whose two resolutions are equal passes them through unchanged.
  const { bin, meta } = generateProvinceMap(
    id,
    {
      map: { width, height },
      map4x: { width, height },
      nations: capitals.map((capital, i) => ({
        name: `Nation ${i + 1}`,
        coordinates: [capital.x, capital.y] as [number, number],
      })),
    },
    terrain,
  );
  const map = decodeProvinceMap(bin, meta);

  return {
    map,
    descriptor: {
      id,
      width,
      height,
      provinceCount: map.provinceCount,
      terrainHash: map.terrainHash,
      partitionHash: map.partitionHash,
    },
    nations: capitals.map((_, i) => ({
      smallID: i + 1,
      name: `Nation ${i + 1}`,
    })),
  };
}

/** Provinces sharing a border with this one, from the loaded artefact. */
export function neighboursOf(map: ProvinceMap, province: number): number[] {
  return map.provinces[province].neighbours;
}
