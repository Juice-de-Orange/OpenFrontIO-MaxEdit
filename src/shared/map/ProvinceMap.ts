/**
 * The province artefact: what the generator writes and both sides read.
 *
 * Until phase 2 the partition was recomputed at startup on the server *and* in
 * the browser, and the two were trusted to agree because they ran the same
 * function over the same bytes. That works right up until the function
 * changes: a generator bugfix deployed into a running season would silently
 * repartition it, and every province id in the command log would start meaning
 * a different place. See docs/decisions/0006.
 *
 * So the partition is now map data. It is generated once by
 * `scripts/genProvinces.ts`, checked in beside `map4x.bin`, and loaded — never
 * derived — by anything that runs.
 *
 * Two files per map:
 *
 * - **`provinces.bin`** — a 32-byte header and one `Uint16` per tile. Big
 *   (2.4 MB for Europe) and extremely compressible, because it is made of long
 *   runs; `map.bin` next to it is 4.9 MB.
 * - **`provinces.json`** — the per-province record. Readable and diffable,
 *   which matters for something a human reviews before it goes into a season.
 *
 * The `Uint16` carries both partitions at once. Land tiles hold a province id;
 * water tiles hold a sea zone with the high bit set. Water was going to need
 * its own array in phase 9 anyway, and the land ids never come near 0x8000 —
 * a nation is capped at 40 provinces.
 */

import type { Province } from "./Province";

/** "PRVM", little-endian. */
export const PROVINCE_MAP_MAGIC = 0x4d565250;

/**
 * Bumped when the byte layout changes. A file from an older generator is
 * refused rather than half-read: this is map data a season stands on, and the
 * failure mode of guessing is a plausible world in the wrong shape.
 */
export const PROVINCE_MAP_FORMAT = 1;

export const HEADER_BYTES = 32;

/** Set on a water tile's entry; the low 15 bits are then its sea zone. */
export const WATER_FLAG = 0x8000;

/** Land with no province, or water in no sea zone (an enclosed lake). */
export const NO_ZONE = 0x7fff;

export interface ProvinceMapHeader {
  width: number;
  height: number;
  provinceCount: number;
  terrainHash: number;
  airZoneCount: number;
  seaZoneCount: number;
}

/** The JSON half, exactly as it is written to disk. */
export interface ProvinceMapMeta extends ProvinceMapHeader {
  formatVersion: number;
  mapId: string;
  /** FNV-1a over the whole of provinces.bin. Checked on the wire. */
  partitionHash: number;
  provinces: Province[];
}

export interface ProvinceMap extends ProvinceMapHeader {
  mapId: string;
  partitionHash: number;
  provinces: Province[];
  /** Province per tile, -1 for water. */
  provinceOfTile: Int32Array;
  /** Sea zone per tile, -1 for land and for unzoned water. */
  seaZoneOfTile: Int32Array;
  /**
   * 1 where a land tile borders a *different land province*.
   *
   * Derived here rather than stored. It is a pure function of the array above,
   * so shipping it would only create a second copy that could disagree with
   * the first, and one linear pass over Europe costs a few milliseconds at
   * load. Coastlines are deliberately excluded: the renderer already draws the
   * shore, and marking it again turns every island into a solid outline.
   */
  borderTiles: Uint8Array;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface EncodeInput extends ProvinceMapHeader {
  /** Province per tile, -1 for water. */
  provinceOfTile: Int32Array;
  /** Sea zone per tile, -1 for land and for unzoned water. */
  seaZoneOfTile: Int32Array;
}

export function encodeProvinceMap(input: EncodeInput): Uint8Array {
  const tiles = input.width * input.height;
  if (input.provinceOfTile.length !== tiles) {
    throw new Error(
      `provinceOfTile has ${input.provinceOfTile.length} entries, expected ${tiles}`,
    );
  }
  if (input.seaZoneOfTile.length !== tiles) {
    throw new Error(
      `seaZoneOfTile has ${input.seaZoneOfTile.length} entries, expected ${tiles}`,
    );
  }
  if (input.provinceCount >= NO_ZONE) {
    throw new Error(
      `${input.provinceCount} provinces does not fit in 15 bits; the format ` +
        `assumes a nation is capped well below that`,
    );
  }

  const bytes = new Uint8Array(HEADER_BYTES + tiles * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, PROVINCE_MAP_MAGIC, true);
  view.setUint32(4, PROVINCE_MAP_FORMAT, true);
  view.setUint32(8, input.width, true);
  view.setUint32(12, input.height, true);
  view.setUint32(16, input.provinceCount, true);
  view.setUint32(20, input.terrainHash >>> 0, true);
  view.setUint32(24, input.airZoneCount, true);
  view.setUint32(28, input.seaZoneCount, true);

  const cells = new Uint16Array(bytes.buffer, HEADER_BYTES, tiles);
  for (let i = 0; i < tiles; i++) {
    const province = input.provinceOfTile[i];
    if (province >= 0) {
      cells[i] = province;
      continue;
    }
    const zone = input.seaZoneOfTile[i];
    cells[i] = WATER_FLAG | (zone >= 0 ? zone : NO_ZONE);
  }
  return bytes;
}

/**
 * FNV-1a over the artefact.
 *
 * The same function `terrainHashFnv1a` uses, over different bytes. It goes in
 * the JSON and on the wire, and it is what turns "the client loaded a stale
 * provinces.bin from its HTTP cache" from mis-coloured territory into an
 * error.
 */
export function partitionHashFnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function decodeProvinceMap(
  bytes: Uint8Array,
  meta: ProvinceMapMeta,
): ProvinceMap {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error(`provinces.bin is ${bytes.byteLength} bytes; not a header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== PROVINCE_MAP_MAGIC) {
    throw new Error(
      `provinces.bin does not start with PRVM (got ${magic.toString(16)})`,
    );
  }
  const format = view.getUint32(4, true);
  if (format !== PROVINCE_MAP_FORMAT) {
    throw new Error(
      `provinces.bin is format ${format}, this build reads ${PROVINCE_MAP_FORMAT}. ` +
        `Regenerate it with npm run gen-provinces`,
    );
  }

  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const provinceCount = view.getUint32(16, true);
  const terrainHash = view.getUint32(20, true);
  const airZoneCount = view.getUint32(24, true);
  const seaZoneCount = view.getUint32(28, true);

  const tiles = width * height;
  if (bytes.byteLength !== HEADER_BYTES + tiles * 2) {
    throw new Error(
      `provinces.bin says ${width}x${height} but is ${bytes.byteLength} bytes, ` +
        `expected ${HEADER_BYTES + tiles * 2}`,
    );
  }

  // The two halves are written together and must stay together. A JSON from
  // one generator run beside a bin from another agrees on nothing that would
  // throw later — it just describes different provinces.
  if (
    meta.width !== width ||
    meta.height !== height ||
    meta.provinceCount !== provinceCount ||
    meta.terrainHash >>> 0 !== terrainHash ||
    meta.airZoneCount !== airZoneCount ||
    meta.seaZoneCount !== seaZoneCount
  ) {
    throw new Error(
      "provinces.json does not describe this provinces.bin; regenerate both",
    );
  }
  if (meta.provinces.length !== provinceCount) {
    throw new Error(
      `provinces.json lists ${meta.provinces.length} provinces, the binary has ${provinceCount}`,
    );
  }

  // A subarray would inherit the header's odd byte offset, which Uint16Array
  // refuses; copy the tile block out instead.
  const cells = new Uint16Array(
    bytes.buffer.slice(
      bytes.byteOffset + HEADER_BYTES,
      bytes.byteOffset + HEADER_BYTES + tiles * 2,
    ),
  );

  const provinceOfTile = new Int32Array(tiles);
  const seaZoneOfTile = new Int32Array(tiles);
  for (let i = 0; i < tiles; i++) {
    const cell = cells[i];
    if ((cell & WATER_FLAG) === 0) {
      provinceOfTile[i] = cell;
      seaZoneOfTile[i] = -1;
      continue;
    }
    provinceOfTile[i] = -1;
    const zone = cell & NO_ZONE;
    seaZoneOfTile[i] = zone === NO_ZONE ? -1 : zone;
  }

  return {
    mapId: meta.mapId,
    partitionHash: meta.partitionHash >>> 0,
    width,
    height,
    provinceCount,
    terrainHash,
    airZoneCount,
    seaZoneCount,
    provinces: meta.provinces,
    provinceOfTile,
    seaZoneOfTile,
    borderTiles: computeBorderTiles(provinceOfTile, width, height),
  };
}

/**
 * Land tiles that touch a different land province.
 *
 * One pass, comparing right and down only and marking both sides, so every
 * edge is examined once.
 */
export function computeBorderTiles(
  provinceOfTile: Int32Array,
  width: number,
  height: number,
): Uint8Array {
  const border = new Uint8Array(provinceOfTile.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = provinceOfTile[i];
      if (a < 0) continue;
      if (x + 1 < width) {
        const b = provinceOfTile[i + 1];
        if (b >= 0 && b !== a) {
          border[i] = 1;
          border[i + 1] = 1;
        }
      }
      if (y + 1 < height) {
        const b = provinceOfTile[i + width];
        if (b >= 0 && b !== a) {
          border[i] = 1;
          border[i + width] = 1;
        }
      }
    }
  }
  return border;
}
