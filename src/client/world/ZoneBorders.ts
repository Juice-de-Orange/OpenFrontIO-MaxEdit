/**
 * Zone borders, drawn as map layers — the same extension point the province
 * borders use (`ProvinceBorders.ts`), for the two zone partitions §6.7 and
 * §6.8 play the air and sea war over.
 *
 * Zones were on the wire from phase 8 and in every zone row of the air panel,
 * and nowhere on the map: a player sending a wing to "zone 22" had no way to
 * see what ground that was. Two layers, not one, because the map-layer shader
 * discards a `"land"` layer's pixels on water and a `"water"` layer's on land
 * (`layer.frag.glsl`), and the air zones are land while the sea zones are
 * water. Both are switched off by default — the map is full enough — and the
 * `z` key shows them together.
 *
 * `computeBorderTiles` is generic over "an id per tile, -1 for none", so the
 * air-zone mask is one indirection away from the province mask, and the
 * sea-zone mask is `seaZoneOfTile` itself.
 */

import type { MapLayer } from "src/shared/map/Maps.gen";
import {
  computeBorderTiles,
  type ProvinceMap,
} from "src/shared/map/ProvinceMap";

export const AIR_ZONE_LAYER = "air-zone-borders";
export const SEA_ZONE_LAYER = "sea-zone-borders";

export const ZONE_LAYERS: MapLayer[] = [
  { id: AIR_ZONE_LAYER, placement: "land" },
  { id: SEA_ZONE_LAYER, placement: "water" },
];

/**
 * Colours, RGBA, at full alpha. The layer draws *under* the territory fill
 * (alpha 150/255), so anything dark there reads as one more province seam;
 * a light line is what survives the fill as a visibly different thing —
 * pale cyan over land, pale sand over the sea, where nothing else is light.
 */
const AIR_RGBA = [190, 245, 255, 255] as const;
const SEA_RGBA = [255, 250, 200, 255] as const;

/** The air zone of every land tile, -1 for water, from the province partition. */
export function airZoneOfTile(
  grid: Pick<ProvinceMap, "provinceOfTile" | "provinces">,
): Int32Array {
  const zones = new Int32Array(grid.provinceOfTile.length).fill(-1);
  for (let tile = 0; tile < zones.length; tile++) {
    const province = grid.provinceOfTile[tile];
    if (province < 0) continue;
    zones[tile] = grid.provinces[province]?.airZone ?? -1;
  }
  return zones;
}

/**
 * The layer image for a border mask in a colour: opaque on a border tile,
 * genuinely zero everywhere else (the shader discards under alpha 0.01).
 */
export function zoneLayerPixels(
  borderTiles: Uint8Array,
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): ImageData {
  if (borderTiles.length !== width * height) {
    throw new Error(
      `zone mask is ${borderTiles.length} tiles, expected ${width * height}`,
    );
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let tile = 0; tile < borderTiles.length; tile++) {
    if (borderTiles[tile] === 0) continue;
    const at = tile * 4;
    pixels[at] = rgba[0];
    pixels[at + 1] = rgba[1];
    pixels[at + 2] = rgba[2];
    pixels[at + 3] = rgba[3];
  }
  return new ImageData(pixels, width, height);
}

/** Both zone masks, from the partition alone. */
export function zoneBorderMasks(
  grid: Pick<ProvinceMap, "provinceOfTile" | "seaZoneOfTile" | "provinces">,
  width: number,
  height: number,
): { air: Uint8Array; sea: Uint8Array } {
  return {
    air: computeBorderTiles(airZoneOfTile(grid), width, height),
    sea: computeBorderTiles(grid.seaZoneOfTile, width, height),
  };
}

/** The two bitmaps the renderer wants, keyed by layer id. */
export async function zoneLayerImages(
  grid: Pick<ProvinceMap, "provinceOfTile" | "seaZoneOfTile" | "provinces">,
  width: number,
  height: number,
): Promise<Map<string, ImageBitmap>> {
  const masks = zoneBorderMasks(grid, width, height);
  const [air, sea] = await Promise.all([
    createImageBitmap(zoneLayerPixels(masks.air, width, height, AIR_RGBA)),
    createImageBitmap(zoneLayerPixels(masks.sea, width, height, SEA_RGBA)),
  ]);
  return new Map([
    [AIR_ZONE_LAYER, air],
    [SEA_ZONE_LAYER, sea],
  ]);
}
