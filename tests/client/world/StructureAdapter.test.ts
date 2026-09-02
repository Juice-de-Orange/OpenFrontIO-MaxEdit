import { describe, expect, test } from "vitest";
import type { FrameUploadTarget } from "../../../src/client/render/frame/Upload";
import { uploadFrameData } from "../../../src/client/render/frame/Upload";
import {
  UT_CIVILIAN_FACTORY,
  UT_MILITARY_FACTORY,
} from "../../../src/client/render/types/UnitType";
import {
  FrameAdapter,
  type FrontGrid,
} from "../../../src/client/world/FrameAdapter";
import { ProvinceTileIndex } from "../../../src/client/world/ProvinceTileIndex";
import {
  STRUCTURE_ICON,
  structureId,
  structuresOf,
  structureTile,
} from "../../../src/client/world/StructureAdapter";
import {
  BUILDING_TYPES,
  buildingIndex,
  BUILDINGS,
  type BuildingType,
} from "../../../src/shared/economy/Buildings";
import { computeProvincePartition } from "../../../src/shared/map/ProvincePartition";

/**
 * Buildings on the map.
 *
 * The passes that draw them were inherited complete and drew nothing for
 * twelve phases, because nothing produced a structure. What is checkable
 * without WebGL is the contract the passes read: a stable id per (province,
 * type), a tile that belongs to the province, the count as the level, the
 * controller as the owner, `markedForDeletion === false` (not 0 — both
 * StructurePass and BarPass test `!== false`), and `structuresDirty` as an
 * edge that the frame consumes.
 */
const LAND = 0x80;
const W = 8;
const H = 4;
const SEEDS = [
  { x: 0, y: 0 },
  { x: 7, y: 0 },
  { x: 0, y: 3 },
  { x: 7, y: 3 },
];

function fixture(): { idx: ProvinceTileIndex; grid: FrontGrid; count: number } {
  const terrain = new Uint8Array(W * H).fill(LAND);
  const partition = computeProvincePartition(terrain, W, H, SEEDS);
  return {
    idx: new ProvinceTileIndex({
      provinceOfTile: partition.provinceOfTile,
      provinceCount: partition.count,
    }),
    grid: { provinceOfTile: partition.provinceOfTile, width: W, height: H },
    count: partition.count,
  };
}

function counts(entries: [province: number, type: BuildingType, n: number][]) {
  const buildings = new Array<number>(4 * BUILDING_TYPES.length).fill(0);
  for (const [province, type, n] of entries) {
    buildings[province * BUILDING_TYPES.length + buildingIndex(type)] = n;
  }
  return buildings;
}

describe("structuresOf", () => {
  test("every slot-taking building type has an icon; the two levels do not", () => {
    for (const type of BUILDING_TYPES) {
      expect(STRUCTURE_ICON[type] !== undefined).toBe(
        BUILDINGS[type].takesSlot,
      );
    }
    // Distinct icons, except the two refineries, which are one building.
    const icons = Object.entries(STRUCTURE_ICON)
      .filter(([type]) => !type.startsWith("synthetic_"))
      .map(([, icon]) => icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  test("a built factory becomes one structure on one of its province's tiles", () => {
    const { idx, grid } = fixture();
    const units = structuresOf(
      counts([[1, "civilian_factory", 3]]),
      [1, 2, 1, 2],
      idx,
    );
    expect(units.size).toBe(1);
    const unit = units.get(structureId(1, "civilian_factory"));
    expect(unit).toBeDefined();
    expect(unit?.unitType).toBe(UT_CIVILIAN_FACTORY);
    expect(unit?.level).toBe(3);
    expect(unit?.ownerID).toBe(2); // the controller, not the partition seed
    expect(unit?.isActive).toBe(true);
    expect(unit?.markedForDeletion).toBe(false);
    expect(unit?.underConstruction).toBe(false);
    expect(grid.provinceOfTile[unit?.pos ?? -1]).toBe(1);
  });

  test("the tile is stable and never Province.centre's mean", () => {
    const { idx, grid } = fixture();
    const a = structureTile(idx, 2, "military_factory");
    const b = structureTile(idx, 2, "military_factory");
    expect(a).toBe(b);
    expect(grid.provinceOfTile[a]).toBe(2);
    // Different types in the same province fan out rather than stacking.
    const tiles = new Set(
      BUILDING_TYPES.filter((t) => STRUCTURE_ICON[t] !== undefined).map((t) =>
        structureTile(idx, 2, t),
      ),
    );
    expect(tiles.size).toBeGreaterThan(1);
  });

  test("ids are positive and distinct across provinces and types", () => {
    const ids = new Set<number>();
    for (let province = 0; province < 4; province++) {
      for (const type of BUILDING_TYPES) {
        const id = structureId(province, type);
        expect(id).toBeGreaterThan(0);
        ids.add(id);
      }
    }
    expect(ids.size).toBe(4 * BUILDING_TYPES.length);
  });

  test("the same counts give the same map, so a rebuild changes nothing", () => {
    const { idx } = fixture();
    const buildings = counts([
      [0, "military_factory", 2],
      [3, "dockyard", 1],
    ]);
    const first = structuresOf(buildings, [1, 1, 1, 1], idx);
    const second = structuresOf(buildings, [1, 1, 1, 1], idx);
    expect([...second.entries()]).toEqual([...first.entries()]);
    expect(first.get(structureId(0, "military_factory"))?.unitType).toBe(
      UT_MILITARY_FACTORY,
    );
  });
});

describe("the frame's structuresDirty edge", () => {
  function recorder() {
    const calls = { structures: 0, units: 0 };
    const target: FrameUploadTarget = {
      uploadTileAndTrailState: () => {},
      uploadLiveDelta: () => {},
      uploadLiveTrailDelta: () => {},
      updateSpiralRibbons: () => {},
      uploadRailroadState: () => {},
      applyRailroadDust: () => {},
      updateUnits: () => {
        calls.units++;
      },
      updateStructures: () => {
        calls.structures++;
      },
      applyDeadUnits: () => {},
      applyConquestEvents: () => {},
      applyBonusEvents: () => {},
      updateAttackRings: () => {},
      updateNukeTelegraphs: () => {},
      updateNames: () => {},
      updateRelations: () => {},
      setSAMAllianceClusters: () => {},
    };
    return { calls, target };
  }

  test("buildings are uploaded once per change, not once per frame", () => {
    const { idx, grid } = fixture();
    const adapter = new FrameAdapter(idx, grid, 4);
    const { calls, target } = recorder();
    adapter.applyFullState([1, 1, 1, 1], 1);
    uploadFrameData(target, adapter.frameData());
    expect(calls.structures).toBe(0); // nothing said the buildings changed

    adapter.applyBuildings(counts([[0, "civilian_factory", 1]]), [1, 1, 1, 1]);
    uploadFrameData(target, adapter.frameData());
    expect(calls.structures).toBe(1);
    expect(adapter.frameData().units.size).toBe(1);

    // Two quiet frames: the edge has been consumed.
    uploadFrameData(target, adapter.frameData());
    uploadFrameData(target, adapter.frameData());
    expect(calls.structures).toBe(1);
    expect(calls.units).toBe(4); // mobile units go every frame regardless
  });
});
