/**
 * A cheap fingerprint of a map's terrain.
 *
 * The province partition is derived independently on both sides and never
 * travels, so nothing on the wire disagrees if the two sides read different
 * map files — the ids simply mean different things, and the only symptom is
 * quietly mis-coloured territory. This hash, sent in the initial state, is
 * what turns that into an error.
 */

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
