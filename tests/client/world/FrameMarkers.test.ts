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
 * The war on the map: a ring per contested province, a pulsing mark per
 * beach an invasion is heading for. Both passes fade and pulse from local
 * time and diff by identity, so what is checkable is what they are handed.
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

function provinces(): Province[] {
  return [0, 1, 2, 3].map((id) => ({
    id,
    nation: 1,
    neighbours: [],
    airZone: 0,
    seaZone: 0,
    terrain: TerrainType.Plains,
    infrastructure: 0,
    buildingSlots: 1,
    resourceDeposits: {},
    tileCount: 8,
    centre: { x: id * 2 + 0.5, y: 1.5 },
    coastal: true,
    capital: false,
  }));
}

describe("applyMarkers", () => {
  test("one ring per contested province, at its centre, keyed by the province", () => {
    const adapter = fixture();
    adapter.applyMarkers(
      [
        { province: 1, attacker: 1, progress: 0.2 },
        { province: 3, attacker: 2, progress: 0.7 },
      ],
      [],
      [1, 2, 1, 1],
      provinces(),
      1,
    );
    const rings = adapter.frameData().attackRings;
    expect(rings.map((r) => r.unitId).sort()).toEqual([2, 4]);
    expect(rings.find((r) => r.unitId === 2)).toMatchObject({ x: 2.5, y: 1.5 });
  });

  test("a spent front against its own controller draws nothing", () => {
    const adapter = fixture();
    adapter.applyMarkers(
      [{ province: 1, attacker: 2, progress: 1 }],
      [],
      [1, 2, 1, 1],
      provinces(),
      1,
    );
    expect(adapter.frameData().attackRings).toEqual([]);
  });

  test("an invasion pulses over its beach, in the viewer's own colour or the enemy's", () => {
    const adapter = fixture();
    adapter.applyMarkers(
      [],
      [
        { attacker: 1, to: 2, ticksLeft: 10 },
        { attacker: 2, to: 0, ticksLeft: 4 },
      ],
      [1, 2, 1, 1],
      provinces(),
      1,
    );
    const marks = adapter.frameData().nukeTelegraphs;
    expect(marks.length).toBe(2);
    expect(marks[0]).toMatchObject({ x: 4.5, y: 1.5, relation: 0 });
    expect(marks[1]).toMatchObject({ x: 0.5, y: 1.5, relation: 2 });
    expect(marks[0].outerRadius).toBeGreaterThan(marks[0].innerRadius);
  });

  test("the next call replaces the last — an ended front's ring goes", () => {
    const adapter = fixture();
    const list = provinces();
    adapter.applyMarkers(
      [{ province: 1, attacker: 1, progress: 0.2 }],
      [],
      [1, 2, 1, 1],
      list,
      1,
    );
    adapter.applyMarkers([], [], [1, 2, 1, 1], list, 1);
    expect(adapter.frameData().attackRings).toEqual([]);
    expect(adapter.frameData().nukeTelegraphs).toEqual([]);
  });
});
