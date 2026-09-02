import { describe, expect, test } from "vitest";
import {
  FrameAdapter,
  type FrontGrid,
} from "../../../src/client/world/FrameAdapter";
import { ProvinceTileIndex } from "../../../src/client/world/ProvinceTileIndex";
import type { Province } from "../../../src/shared/map/Province";
import { computeProvincePartition } from "../../../src/shared/map/ProvincePartition";
import { TerrainType } from "../../../src/shared/map/Terrain";

/**
 * Names on the map. `NamePass` was inherited whole and drew nothing because
 * nothing fed it; what is checkable without WebGL is its contract: a label
 * keyed by the header id over the largest province a nation holds, a size in
 * tiles inside legible bounds, a live `PlayerState` per nation that holds
 * land and a dead one for a nation that holds none.
 */
const LAND = 0x80;
const W = 8;
const H = 4;

function fixture(): FrameAdapter {
  const terrain = new Uint8Array(W * H).fill(LAND);
  const partition = computeProvincePartition(terrain, W, H, [
    { x: 0, y: 0 },
    { x: 7, y: 0 },
    { x: 0, y: 3 },
    { x: 7, y: 3 },
  ]);
  const idx = new ProvinceTileIndex({
    provinceOfTile: partition.provinceOfTile,
    provinceCount: partition.count,
  });
  const grid: FrontGrid = {
    provinceOfTile: partition.provinceOfTile,
    width: W,
    height: H,
  };
  return new FrameAdapter(idx, grid, 4);
}

function provinces(tileCounts: number[]): Province[] {
  return tileCounts.map((tileCount, id) => ({
    id,
    nation: 1,
    neighbours: [],
    airZone: 0,
    seaZone: null,
    terrain: TerrainType.Plains,
    infrastructure: 0,
    buildingSlots: 1,
    resourceDeposits: {},
    tileCount,
    centre: { x: id * 10 + 5, y: 20 },
    coastal: false,
    capital: id === 0,
  }));
}

const NATIONS = [{ smallID: 1 }, { smallID: 2 }, { smallID: 3 }];

describe("applyLabels", () => {
  test("one label per nation that holds land, over its largest province", () => {
    const adapter = fixture();
    adapter.applyLabels(
      [1, 1, 2, 2],
      provinces([900, 1600, 400, 300]),
      NATIONS,
    );
    const frame = adapter.frameData();
    const one = frame.names.get("nation-1");
    const two = frame.names.get("nation-2");
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    // Nation 1's largest province is id 1 (1600 tiles), centred at x = 15.
    expect(one?.x).toBe(15);
    expect(one?.y).toBeLessThan(20); // a third of the size up, as upstream
    expect(two?.x).toBe(25);
    expect(one?.playerID).toBe("nation-1");
    // Size grows with land and stays inside legible bounds.
    expect(one?.size ?? 0).toBeGreaterThan(two?.size ?? 0);
    expect(one?.size ?? 0).toBeLessThanOrEqual(40);
    expect(two?.size ?? 0).toBeGreaterThanOrEqual(6);
  });

  test("a nation holding nothing has no label and is dead to the pass", () => {
    const adapter = fixture();
    adapter.applyLabels([1, 1, 2, 2], provinces([900, 900, 900, 900]), NATIONS);
    const frame = adapter.frameData();
    expect(frame.names.has("nation-3")).toBe(false);
    expect(frame.players.get(3)?.isAlive).toBe(false);
    expect(frame.players.get(1)?.isAlive).toBe(true);
    expect(frame.players.get(1)?.tilesOwned).toBe(1800);
  });

  test("losing the last province removes the label on the next call", () => {
    const adapter = fixture();
    const list = provinces([900, 900, 900, 900]);
    adapter.applyLabels([1, 1, 2, 2], list, NATIONS);
    expect(adapter.frameData().names.has("nation-2")).toBe(true);
    adapter.applyLabels([1, 1, 1, 1], list, NATIONS);
    expect(adapter.frameData().names.has("nation-2")).toBe(false);
    expect(adapter.frameData().players.get(2)?.isAlive).toBe(false);
    // And the maps are the frame's own objects, mutated in place.
    const before = adapter.frameData().names;
    adapter.applyLabels([1, 1, 2, 2], list, NATIONS);
    expect(adapter.frameData().names).toBe(before);
  });
});
