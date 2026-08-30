import { assetUrl } from "src/client/util/AssetUrl";
import { GameMapType } from "src/shared/map/Maps.gen";
import {
  buildPreviewMap,
  PREVIEW_MAP_H,
  PREVIEW_MAP_W,
  type PreviewMapData,
} from "./PreviewMap";

/**
 * The preview renders one fixed map, so it fetches that map's two files
 * itself rather than going through client/TerrainMapFileLoader.
 *
 * That loader wraps core/game/FetchGameMapLoader, which reaches GameMapLoader,
 * Game and TerrainMapLoader — the whole simulation, pulled in for two GETs
 * against a hardcoded map. Its extras (per-map caching of the descriptor,
 * mapBin/map16xBin/webpPath/layerPng) are all unused here; `pending` below
 * already caches the one result that matters.
 */

/**
 * Derived from the catalog rather than written as a literal, so removing or
 * renaming the map is a compile error instead of a 404 in the store preview.
 * Lowercasing the enum key is how the asset folders are named — the same
 * derivation core/game/FetchGameMapLoader does.
 */
const PREVIEW_MAP_DIR = GameMapType.Australia.toLowerCase();

/** The slice of a map manifest the preview needs. */
interface PreviewMapManifest {
  map4x: { width: number; height: number };
}

async function fetchAsset(path: string): Promise<Response> {
  const url = assetUrl(`maps/${PREVIEW_MAP_DIR}/${path}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.statusText}`);
  }
  return response;
}

let pending: Promise<PreviewMapData> | undefined;

/** Fetch the preview map's terrain (once per page) from the map assets. */
export function loadPreviewMap(): Promise<PreviewMapData> {
  pending ??= (async () => {
    const [manifest, bin] = await Promise.all([
      fetchAsset("manifest.json").then(
        (r) => r.json() as Promise<PreviewMapManifest>,
      ),
      fetchAsset("map4x.bin")
        .then((r) => r.arrayBuffer())
        .then((b) => new Uint8Array(b)),
    ]);
    const { width, height } = manifest.map4x;
    // Kept deliberately: without it a resized map renders offset terrain in
    // the store instead of failing.
    if (width !== PREVIEW_MAP_W || height !== PREVIEW_MAP_H) {
      throw new Error(
        `Preview map: expected ${PREVIEW_MAP_W}x${PREVIEW_MAP_H}, manifest says ${width}x${height}`,
      );
    }
    return buildPreviewMap(bin, width, height);
  })();
  pending.catch(() => {
    pending = undefined; // let a later open retry
  });
  return pending;
}
