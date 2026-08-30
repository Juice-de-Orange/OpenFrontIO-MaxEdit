/**
 * Loading a world's map assets.
 *
 * Two files: the manifest (dimensions and the nation seed list) and the
 * terrain bytes. Fetched directly rather than through a map-loader
 * abstraction — the world client opens one map and keeps it for the session,
 * so the per-map caching and the mapBin/map16x/thumbnail/layer accessors of
 * the inherited loader have nothing to do here.
 *
 * Terrain byte layout, unchanged from upstream: bit 7 land, bit 6 shoreline,
 * bit 5 ocean, bits 0-4 magnitude.
 */

import { assetUrl } from "src/client/util/AssetUrl";
import {
  decodeProvinceMap,
  type ProvinceMap,
  type ProvinceMapMeta,
} from "src/shared/map/ProvinceMap";

/** A nation seed from the map manifest. Coordinates are full-resolution. */
export interface MapNation {
  name: string;
  flag?: string;
  coordinates: [number, number];
}

interface MapManifestFile {
  map: { width: number; height: number };
  map4x: { width: number; height: number };
  nations?: MapNation[];
}

export interface WorldMap {
  /** Directory under resources/maps, e.g. "europe". */
  id: string;
  width: number;
  height: number;
  terrain: Uint8Array;
  /** Nation seeds, already scaled to this map's resolution. */
  nations: MapNation[];
  /**
   * The province partition and everything derived from it.
   *
   * Loaded, not computed. Both sides used to run `computeProvincePartition`
   * over these terrain bytes and were trusted to agree; they now read one
   * generated file, and `partitionHash` in the world's opening state is what
   * proves this client did not serve a stale copy of it out of its HTTP cache
   * (docs/decisions/0006).
   */
  provinces: ProvinceMap;
}

async function fetchAsset(mapId: string, file: string): Promise<Response> {
  const url = assetUrl(`maps/${mapId}/${file}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.statusText}`);
  }
  return response;
}

/**
 * Load a map at quarter resolution.
 *
 * map4x rather than map.bin: at 1452x836 Europe is 1.2 MB and a province pass
 * over it is milliseconds, where the full 2904x1672 is 4.9 MB for no visible
 * gain at phase 0 — the province grid is 64 tiles wide either way. Both sides
 * must pick the same one, which is what the terrain hash in the initial state
 * exists to prove.
 */
export async function loadWorldMap(mapId: string): Promise<WorldMap> {
  const [manifest, terrain, provinceBin, provinceMeta] = await Promise.all([
    fetchAsset(mapId, "manifest.json").then(
      (r) => r.json() as Promise<MapManifestFile>,
    ),
    fetchAsset(mapId, "map4x.bin")
      .then((r) => r.arrayBuffer())
      .then((b) => new Uint8Array(b)),
    fetchAsset(mapId, "provinces.bin")
      .then((r) => r.arrayBuffer())
      .then((b) => new Uint8Array(b)),
    fetchAsset(mapId, "provinces.json").then(
      (r) => r.json() as Promise<ProvinceMapMeta>,
    ),
  ]);

  const { width, height } = manifest.map4x;
  if (terrain.length !== width * height) {
    throw new Error(
      `Map ${mapId}: manifest says ${width}x${height} (${width * height} bytes), ` +
        `map4x.bin has ${terrain.length}`,
    );
  }

  // Manifest coordinates are in full-map space; scale them to the resolution
  // actually loaded. Getting this wrong puts every capital in the top-left
  // quadrant, which looks like a partition bug rather than a scaling one.
  const scale = manifest.map.width / width;
  const nations = (manifest.nations ?? []).map((n) => ({
    ...n,
    coordinates: [
      Math.min(width - 1, Math.round(n.coordinates[0] / scale)),
      Math.min(height - 1, Math.round(n.coordinates[1] / scale)),
    ] as [number, number],
  }));

  const provinces = decodeProvinceMap(provinceBin, provinceMeta);
  if (provinces.width !== width || provinces.height !== height) {
    throw new Error(
      `Map ${mapId}: the manifest says ${width}x${height}, the province ` +
        `artefact says ${provinces.width}x${provinces.height}`,
    );
  }

  return { id: mapId, width, height, terrain, nations, provinces };
}
