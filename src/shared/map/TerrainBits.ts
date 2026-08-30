/**
 * The terrain byte, read in one place.
 *
 * Upstream's `GameMapImpl` holds these as private static fields, so every
 * other reader has had to restate them — `ProvincePartition.ts` carried its
 * own `LAND_BIT = 0x80`, and the province attribute derivation would have
 * carried three more. Four copies of a bit layout is three chances to get one
 * of them wrong, and a wrong bit here does not throw: it produces a plausible
 * map with the mountains in the wrong places.
 *
 * Layout, unchanged from upstream: bit 7 land, bit 6 shoreline, bit 5 ocean,
 * bits 0-4 magnitude. Land with magnitude 31 is impassable.
 */

import { TerrainType } from "./Terrain";

export const LAND_BIT = 1 << 7;
export const SHORELINE_BIT = 1 << 6;
export const OCEAN_BIT = 1 << 5;
export const MAGNITUDE_MASK = 0x1f;

/** Land at this magnitude is impassable rather than merely high. */
export const IMPASSABLE_MAGNITUDE = 31;

/** Magnitude below this is Plains; below HIGHLAND_MAX_MAGNITUDE, Highland. */
export const PLAINS_MAX_MAGNITUDE = 10;
export const HIGHLAND_MAX_MAGNITUDE = 20;

export function isLandByte(byte: number): boolean {
  return (byte & LAND_BIT) !== 0;
}

export function isOceanByte(byte: number): boolean {
  return (byte & OCEAN_BIT) !== 0;
}

export function isShorelineByte(byte: number): boolean {
  return (byte & SHORELINE_BIT) !== 0;
}

export function magnitudeOf(byte: number): number {
  return byte & MAGNITUDE_MASK;
}

/**
 * The same classification `GameMapImpl.terrainType` makes, from the byte
 * alone.
 *
 * The thresholds are duplicated from there rather than shared, because that
 * file is the inherited renderer's map and this one is the world server's;
 * they are kept in step by `tests/shared/TerrainBits.test.ts`, which asserts
 * the two agree over every possible byte.
 */
export function terrainTypeOfByte(byte: number): TerrainType {
  if (!isLandByte(byte)) return TerrainType.Ocean;
  const magnitude = magnitudeOf(byte);
  if (magnitude >= IMPASSABLE_MAGNITUDE) return TerrainType.Impassable;
  if (magnitude < PLAINS_MAX_MAGNITUDE) return TerrainType.Plains;
  if (magnitude < HIGHLAND_MAX_MAGNITUDE) return TerrainType.Highland;
  return TerrainType.Mountain;
}
