/**
 * Phase-0 province partition: a fixed grid over the land tiles.
 *
 * **Deliberately throwaway.** Phase 2 replaces this with a real partition
 * (multi-source BFS from the manifest's nation seeds, Lloyd relaxation, strait
 * edges) shipped as a checked-in file over HTTP. What this exists for is to
 * exercise the code path that partition will fill — province ownership over
 * the wire, tiles derived on the client — so that when the real one arrives,
 * no client code has to change.
 *
 * The province -> tile mapping is **static map data, not world state**. It
 * never goes into a delta, a snapshot, or a protocol field; both sides derive
 * it from the same terrain bytes with this same function. `terrainHashFnv1a`
 * is what makes that agreement checkable: the server sends its hash in the
 * initial state and the client refuses to render if its own terrain disagrees.
 * Without it, a mismatch (one side reading map.bin, the other map4x.bin) shows
 * up as quietly mis-coloured regions and nothing else.
 */

/** Land bit in the engine's terrain byte layout. */
const LAND_BIT = 0x80;

export interface ProvinceGrid {
  /** Number of provinces. Ids are 0..count-1. */
  count: number;
  /** Province id per tile, or -1 for water. Length is w*h. */
  provinceOfTile: Int32Array;
  /** Tile-space centre of each province, for seeding ownership. */
  centres: { x: number; y: number }[];
}

/**
 * Partition the land tiles of a terrain buffer into a `cell`-sized grid.
 *
 * Cells with no land are not provinces, so ids stay dense and every province
 * is non-empty — an invariant phase 2's generator has to keep too.
 */
export function computeProvinceGrid(
  terrain: Uint8Array,
  width: number,
  height: number,
  cell = 64,
): ProvinceGrid {
  if (terrain.length !== width * height) {
    throw new Error(
      `terrain is ${terrain.length} bytes, expected ${width * height}`,
    );
  }

  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);

  // First pass: which cells contain land, and where their land sits.
  const cellCount = cols * rows;
  const landPerCell = new Int32Array(cellCount);
  const sumX = new Float64Array(cellCount);
  const sumY = new Float64Array(cellCount);

  for (let y = 0; y < height; y++) {
    const cy = (y / cell) | 0;
    for (let x = 0; x < width; x++) {
      if ((terrain[y * width + x] & LAND_BIT) === 0) continue;
      const c = cy * cols + ((x / cell) | 0);
      landPerCell[c]++;
      sumX[c] += x;
      sumY[c] += y;
    }
  }

  // Dense ids for the cells that have land.
  const idOfCell = new Int32Array(cellCount).fill(-1);
  const centres: { x: number; y: number }[] = [];
  for (let c = 0; c < cellCount; c++) {
    if (landPerCell[c] === 0) continue;
    idOfCell[c] = centres.length;
    centres.push({
      x: Math.round(sumX[c] / landPerCell[c]),
      y: Math.round(sumY[c] / landPerCell[c]),
    });
  }

  // Second pass: label every land tile.
  const provinceOfTile = new Int32Array(width * height).fill(-1);
  for (let y = 0; y < height; y++) {
    const cy = (y / cell) | 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if ((terrain[i] & LAND_BIT) === 0) continue;
      provinceOfTile[i] = idOfCell[cy * cols + ((x / cell) | 0)];
    }
  }

  return { count: centres.length, provinceOfTile, centres };
}

/**
 * FNV-1a over the terrain bytes, as an unsigned 32-bit number.
 *
 * Cheap enough to run on both sides at load (~1 ms for 1.2 MB) and the only
 * thing standing between a map mismatch and silently wrong territory.
 */
export function terrainHashFnv1a(terrain: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < terrain.length; i++) {
    hash ^= terrain[i];
    // hash * 16777619, kept in 32 bits without overflowing the float mantissa.
    hash =
      (hash +
        ((hash << 1) +
          (hash << 4) +
          (hash << 7) +
          (hash << 8) +
          (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
}
