/**
 * Province -> tiles, in CSR form.
 *
 * Built once at load from the same province artefact the server loaded. Two
 * linear scans: count tiles per province, then fill. `tilesOf` returns a
 * subarray — a view, not a copy — so expanding a delta allocates nothing.
 *
 * This is static map data. It is never sent, never stored, and never part of
 * a delta; both sides read it from the file checked in beside the terrain.
 */

/** What the index needs: a tile -> province array and how many provinces. */
export interface ProvinceTileSource {
  provinceOfTile: Int32Array;
  provinceCount: number;
}

export class ProvinceTileIndex {
  private readonly offsets: Int32Array;
  private readonly tiles: Int32Array;

  /** Total tiles on the map, land and water. */
  readonly tileCount: number;
  readonly provinceCount: number;

  constructor(grid: ProvinceTileSource) {
    const { provinceOfTile, provinceCount: count } = grid;
    this.tileCount = provinceOfTile.length;
    this.provinceCount = count;

    // Pass 1: how many tiles each province owns.
    const counts = new Int32Array(count);
    let land = 0;
    for (let i = 0; i < provinceOfTile.length; i++) {
      const p = provinceOfTile[i];
      if (p < 0) continue;
      counts[p]++;
      land++;
    }

    // Prefix sums.
    this.offsets = new Int32Array(count + 1);
    for (let p = 0; p < count; p++) {
      this.offsets[p + 1] = this.offsets[p] + counts[p];
    }

    // Pass 2: fill, using a moving cursor per province.
    this.tiles = new Int32Array(land);
    const cursor = Int32Array.from(this.offsets.subarray(0, count));
    for (let i = 0; i < provinceOfTile.length; i++) {
      const p = provinceOfTile[i];
      if (p < 0) continue;
      this.tiles[cursor[p]++] = i;
    }
  }

  /** The tiles of one province. A view into the shared buffer — do not mutate. */
  tilesOf(province: number): Int32Array {
    if (province < 0 || province >= this.provinceCount) {
      return this.tiles.subarray(0, 0);
    }
    return this.tiles.subarray(
      this.offsets[province],
      this.offsets[province + 1],
    );
  }
}
