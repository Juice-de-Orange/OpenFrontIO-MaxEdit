/**
 * Generating a map's province artefact.
 *
 * Pure: bytes in, bytes out, no filesystem. That is what lets
 * `tests/shared/ProvinceArtifact.test.ts` regenerate Europe and compare it
 * byte for byte against what is checked in — the guard that catches a change
 * to the partition or the attribute rules that nobody regenerated for.
 *
 * `scripts/genProvinces.ts` is the thin shell around this that reads and
 * writes files.
 */

import {
  computeNationOfTile,
  type BorderCollection,
  type BordersFit,
} from "src/build/NationBorders";
import { deriveProvinces } from "src/shared/map/ProvinceAttributes";
import {
  encodeProvinceMap,
  partitionHashFnv1a,
  PROVINCE_MAP_FORMAT,
  type ProvinceMapMeta,
} from "src/shared/map/ProvinceMap";
import { computeProvincePartition } from "src/shared/map/ProvincePartition";
import { terrainHashFnv1a } from "src/shared/map/TerrainHash";

/** The parts of a map manifest the generator reads. */
export interface GeneratorManifest {
  map: { width: number; height: number };
  map4x: { width: number; height: number };
  nations?: { name: string; coordinates: [number, number] }[];
}

/**
 * Real borders, when the map has them: the fitted transform plus the
 * filtered Natural Earth geometry, both checked in next to the manifest.
 * Without them the partition falls back to growing nations from their
 * capitals.
 */
export interface GeneratorBorders {
  fit: BordersFit;
  geometry: BorderCollection;
}

export interface GeneratedProvinceMap {
  bin: Uint8Array;
  meta: ProvinceMapMeta;
}

/**
 * Nation capitals, scaled from full-map coordinates to the resolution the
 * world actually runs on.
 *
 * Exported because the server and the client both used to do this inline and
 * had to agree; now only the generator does it, and everyone else reads the
 * answer. Getting the scale wrong puts every capital in the top-left quadrant,
 * which looks like a partition bug rather than an arithmetic one.
 */
export function scaleCapitals(
  manifest: GeneratorManifest,
): { x: number; y: number }[] {
  const { width, height } = manifest.map4x;
  const scale = manifest.map.width / width;
  return (manifest.nations ?? []).map((nation) => ({
    x: Math.min(width - 1, Math.round(nation.coordinates[0] / scale)),
    y: Math.min(height - 1, Math.round(nation.coordinates[1] / scale)),
  }));
}

export function generateProvinceMap(
  mapId: string,
  manifest: GeneratorManifest,
  terrain: Uint8Array,
  borders?: GeneratorBorders,
): GeneratedProvinceMap {
  const { width, height } = manifest.map4x;
  if (terrain.length !== width * height) {
    throw new Error(
      `${mapId}: manifest says ${width}x${height}, map4x.bin has ${terrain.length} bytes`,
    );
  }

  const capitals = scaleCapitals(manifest);
  const nationOfTile = borders
    ? computeNationOfTile(
        terrain,
        width,
        height,
        capitals,
        (manifest.nations ?? []).map((nation) => nation.name),
        borders.fit,
        borders.geometry,
      )
    : undefined;
  const partition = computeProvincePartition(
    terrain,
    width,
    height,
    capitals,
    nationOfTile,
  );
  const terrainHash = terrainHashFnv1a(terrain);
  const derived = deriveProvinces({
    terrain,
    width,
    height,
    partition,
    capitals,
    terrainHash,
  });

  const header = {
    width,
    height,
    provinceCount: partition.count,
    terrainHash,
    airZoneCount: derived.airZoneCount,
    seaZoneCount: derived.seaZoneCount,
  };

  const bin = encodeProvinceMap({
    ...header,
    provinceOfTile: partition.provinceOfTile,
    seaZoneOfTile: derived.seaZoneOfTile,
  });

  return {
    bin,
    meta: {
      ...header,
      formatVersion: PROVINCE_MAP_FORMAT,
      mapId,
      partitionHash: partitionHashFnv1a(bin),
      provinces: derived.provinces,
    },
  };
}

/**
 * The JSON half, serialised the one way everything agrees on.
 *
 * Two spaces and a trailing newline, so the checked-in file is what prettier
 * would have produced and a regeneration shows up as a content diff rather
 * than a whitespace one.
 */
export function serialiseProvinceMeta(meta: ProvinceMapMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}
