/**
 * Province borders, drawn as a map layer.
 *
 * The renderer already has an extension point for "a full-map image over the
 * terrain, under the territory, with a visibility toggle": map layers
 * (`MapRenderer.setMapLayers`, `MapLayerPass`). Upstream uses it for painted
 * overlays on a few maps; it takes an RGBA `ImageBitmap`, discards transparent
 * pixels and land/water mismatches in the shader, and honours
 * `setLayerVisible`.
 *
 * That is the whole feature, so this file makes an image and hands it over. A
 * dedicated WebGL pass would have meant new shaders, a new `FrameData` field,
 * a new entry in the draw order and about three hundred lines — none of which
 * could be verified anywhere in this project, because the browser leg has no
 * automated test (HANDOVER.md). Two dozen lines through an existing, working
 * pass is worth more than three hundred nobody can run.
 *
 * **The layer draws under the territory fill**, which is alpha 150/255. A
 * border inside a nation's own territory therefore reads as a dark seam rather
 * than a hard line. That is a consequence of where map layers sit in the draw
 * order, and it happens to be the right weight for a border that is on screen
 * all the time.
 */

import type { MapLayer } from "src/shared/map/Maps.gen";

/** The layer id. Also the key `setLayerVisible` toggles. */
export const PROVINCE_BORDER_LAYER = "province-borders";

export const PROVINCE_BORDER_LAYERS: MapLayer[] = [
  { id: PROVINCE_BORDER_LAYER, placement: "land" },
];

/**
 * Border colour, RGBA.
 *
 * Black at a little over half alpha. Under the territory fill this lands as a
 * seam a shade darker than the province either side of it, which is what a
 * border that is never switched off should look like.
 */
const BORDER_RGBA = [0, 0, 0, 140] as const;

/**
 * The layer image: opaque on a border tile, fully transparent everywhere else.
 *
 * Transparent and not merely unwritten: the shader discards below alpha 0.01,
 * so every non-border pixel has to actually be zero. A `Uint8ClampedArray`
 * starts that way, which is why nothing here clears it.
 */
export function borderLayerPixels(
  borderTiles: Uint8Array,
  width: number,
  height: number,
): ImageData {
  if (borderTiles.length !== width * height) {
    throw new Error(
      `border mask is ${borderTiles.length} tiles, expected ${width * height}`,
    );
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let tile = 0; tile < borderTiles.length; tile++) {
    if (borderTiles[tile] === 0) continue;
    const at = tile * 4;
    rgba[at] = BORDER_RGBA[0];
    rgba[at + 1] = BORDER_RGBA[1];
    rgba[at + 2] = BORDER_RGBA[2];
    rgba[at + 3] = BORDER_RGBA[3];
  }
  return new ImageData(rgba, width, height);
}

/** The image bitmap the renderer wants, keyed by layer id. */
export async function borderLayerImages(
  borderTiles: Uint8Array,
  width: number,
  height: number,
): Promise<Map<string, ImageBitmap>> {
  const bitmap = await createImageBitmap(
    borderLayerPixels(borderTiles, width, height),
  );
  return new Map([[PROVINCE_BORDER_LAYER, bitmap]]);
}
