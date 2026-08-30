import { describe, expect, test } from "vitest";
import { GameMapImpl } from "../../src/shared/map/GameMap";
import { TerrainType } from "../../src/shared/map/Terrain";
import {
  isLandByte,
  isOceanByte,
  isShorelineByte,
  magnitudeOf,
  terrainTypeOfByte,
} from "../../src/shared/map/TerrainBits";

/**
 * The bit layout is stated in two places: privately inside the inherited
 * `GameMapImpl`, and openly in `TerrainBits`. Two statements of one layout is
 * one chance for them to drift, and drift here does not throw — it puts the
 * mountains somewhere else. So compare them over every byte a tile can hold.
 */
describe("TerrainBits agrees with the inherited GameMap", () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const map = new GameMapImpl(256, 1, all, 0);

  test("classifies all 256 bytes identically", () => {
    for (let byte = 0; byte < 256; byte++) {
      expect(terrainTypeOfByte(byte), `byte ${byte}`).toBe(
        map.terrainType(byte),
      );
      expect(isLandByte(byte), `land ${byte}`).toBe(map.isLand(byte));
      expect(isOceanByte(byte), `ocean ${byte}`).toBe(map.isOcean(byte));
      expect(isShorelineByte(byte), `shore ${byte}`).toBe(
        map.isShoreline(byte),
      );
      expect(magnitudeOf(byte), `magnitude ${byte}`).toBe(map.magnitude(byte));
    }
  });

  test("water is Ocean whatever its other bits say", () => {
    expect(terrainTypeOfByte(0)).toBe(TerrainType.Ocean);
    expect(terrainTypeOfByte(0x3f)).toBe(TerrainType.Ocean);
  });

  test("land at magnitude 31 is impassable, not mountain", () => {
    expect(terrainTypeOfByte(0x80 | 31)).toBe(TerrainType.Impassable);
    expect(terrainTypeOfByte(0x80 | 30)).toBe(TerrainType.Mountain);
  });
});
