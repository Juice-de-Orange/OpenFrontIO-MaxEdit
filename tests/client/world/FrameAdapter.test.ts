import { beforeEach, describe, expect, test } from "vitest";
import type { FrameUploadTarget } from "../../../src/client/render/frame/Upload";
import { uploadFrameData } from "../../../src/client/render/frame/Upload";
import {
  FrameAdapter,
  type FrontGrid,
} from "../../../src/client/world/FrameAdapter";
import { ProvinceTileIndex } from "../../../src/client/world/ProvinceTileIndex";
import { computeProvincePartition } from "../../../src/shared/map/ProvincePartition";

const LAND = 0x80;
const W = 8;
const H = 4;
const SEEDS = [
  { x: 0, y: 0 },
  { x: 7, y: 0 },
  { x: 0, y: 3 },
  { x: 7, y: 3 },
];

/** All land, split between four seeds in the corners. */
function index(): { idx: ProvinceTileIndex; grid: FrontGrid } {
  const terrain = new Uint8Array(W * H).fill(LAND);
  const partition = computeProvincePartition(terrain, W, H, SEEDS);
  return {
    idx: new ProvinceTileIndex({
      provinceOfTile: partition.provinceOfTile,
      provinceCount: partition.count,
    }),
    grid: { provinceOfTile: partition.provinceOfTile, width: W, height: H },
  };
}

/**
 * Records what the renderer was handed. The upload target is structural, so
 * no WebGL is involved -- which is what makes the contract testable at all.
 */
function recorder() {
  const calls = {
    full: [] as { tileState: Uint16Array; trailState: Uint16Array }[],
    delta: [] as { tileState: Uint16Array; changedTiles: readonly number[] }[],
  };
  const target: FrameUploadTarget = {
    uploadTileAndTrailState: (tileState, trailState) =>
      calls.full.push({ tileState, trailState }),
    uploadLiveDelta: (tileState, changedTiles) =>
      // Copy the ref list: the adapter reuses that array, and the assertion is
      // about what was visible at call time.
      calls.delta.push({ tileState, changedTiles: [...changedTiles] }),
    uploadLiveTrailDelta: () => {},
    updateSpiralRibbons: () => {},
    uploadRailroadState: () => {},
    applyRailroadDust: () => {},
    updateUnits: () => {},
    updateStructures: () => {},
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

describe("FrameAdapter", () => {
  let adapter: FrameAdapter;
  let idx: ProvinceTileIndex;

  let grid: FrontGrid;

  beforeEach(() => {
    ({ idx, grid } = index());
    adapter = new FrameAdapter(idx, grid, 4);
  });

  test("hands the renderer the same buffers every tick", () => {
    const { calls, target } = recorder();
    adapter.applyFullState(new Array(idx.provinceCount).fill(1), 1);
    uploadFrameData(target, adapter.frameData());

    const seenTile = new Set<Uint16Array>();
    const seenTrail = new Set<Uint16Array>();
    seenTile.add(calls.full[0].tileState);
    seenTrail.add(calls.full[0].trailState);

    for (let tick = 2; tick <= 6; tick++) {
      adapter.applyDelta([[0, (tick % 3) + 1]], tick);
      const frame = adapter.frameData();
      uploadFrameData(target, frame);
      seenTile.add(frame.tileState);
      seenTrail.add(frame.trailState);
    }

    // toBe-identity, not toEqual: a fresh array per tick passes an equality
    // check and then freezes the screen after frame one, because TrailPass and
    // RailroadPass read the reference they were handed, at draw time.
    expect(seenTile.size).toBe(1);
    expect(seenTrail.size).toBe(1);
  });

  test("events carries three empty arrays, not an empty object", () => {
    const f = adapter.frameData();
    expect(Object.keys(f.events).sort()).toEqual([
      "bonusEvents",
      "conquestEvents",
      "deadUnits",
    ]);
    expect(f.events.deadUnits).toHaveLength(0);
    expect(f.events.conquestEvents).toHaveLength(0);
    expect(f.events.bonusEvents).toHaveLength(0);
  });

  test("first frame is a full upload, and no delta", () => {
    const { calls, target } = recorder();
    adapter.applyFullState(new Array(idx.provinceCount).fill(2), 1);
    uploadFrameData(target, adapter.frameData());
    expect(calls.full).toHaveLength(1);
    expect(calls.delta).toHaveLength(0);
  });

  test("a tick with no change uploads nothing", () => {
    const { calls, target } = recorder();
    adapter.applyFullState(new Array(idx.provinceCount).fill(1), 1);
    uploadFrameData(target, adapter.frameData());
    adapter.applyDelta([], 2);
    uploadFrameData(target, adapter.frameData());
    expect(calls.full).toHaveLength(1);
    expect(calls.delta).toHaveLength(0);
  });

  test("one changed province uploads exactly its tiles", () => {
    const { calls, target } = recorder();
    adapter.applyFullState(new Array(idx.provinceCount).fill(1), 1);
    uploadFrameData(target, adapter.frameData());

    adapter.applyDelta([[3, 2]], 2);
    uploadFrameData(target, adapter.frameData());

    const expected = [...idx.tilesOf(3)].sort((a, b) => a - b);
    expect(calls.delta).toHaveLength(1);
    expect([...calls.delta[0].changedTiles].sort((a, b) => a - b)).toEqual(
      expected,
    );
    for (const tile of expected) {
      expect(calls.delta[0].tileState[tile]).toBe(2);
    }
  });

  test("a change past a quarter of the map falls back to a full upload", () => {
    const { calls, target } = recorder();
    adapter.applyFullState(new Array(idx.provinceCount).fill(1), 1);
    uploadFrameData(target, adapter.frameData());

    // 3 of 8 provinces = 12 of 32 tiles, past the 25% threshold.
    adapter.applyDelta(
      [
        [0, 3],
        [1, 3],
        [2, 3],
      ],
      2,
    );
    uploadFrameData(target, adapter.frameData());

    // Without this test the fallback is dead code: at phase-0 scale a handful
    // of provinces flip per tick, so it would first run in phase 2, having
    // never been exercised.
    expect(calls.full).toHaveLength(2);
    expect(calls.delta).toHaveLength(0);
  });

  test("a front fills the province from the attacking border, tile by tile", () => {
    // Nation 1 everywhere except province 1, which nation 2 holds and
    // nation 1 attacks. The controller stays 2 the whole time (invariant 8):
    // only tiles change colour.
    const controllers = new Array<number>(idx.provinceCount).fill(1);
    controllers[1] = 2;
    adapter.applyFullState(controllers, 1);
    adapter.applyFronts([], controllers);

    const tiles = [...idx.tilesOf(1)];
    const painted = (): number[] =>
      tiles.filter((tile) => adapter.frameData().tileState[tile] === 1);

    const attackerTiles = new Set<number>();
    for (let province = 0; province < idx.provinceCount; province++) {
      if (controllers[province] !== 1) continue;
      for (const tile of idx.tilesOf(province)) attackerTiles.add(tile);
    }
    const touchesAttacker = (tile: number): boolean => {
      const x = tile % W;
      return [
        x > 0 ? tile - 1 : -1,
        x < W - 1 ? tile + 1 : -1,
        tile - W,
        tile + W,
      ].some((next) => attackerTiles.has(next));
    };

    // A quarter in: a quarter of the tiles, and they hug the border the
    // attack comes over.
    adapter.applyFronts([{ province: 1, attacker: 1, progress: 0.25 }], controllers);
    const quarter = painted();
    expect(quarter.length).toBe(Math.floor(tiles.length * 0.25));
    for (const tile of quarter) {
      expect(touchesAttacker(tile), `tile ${tile} is not at the border`).toBe(
        true,
      );
    }

    // Half in: the quarter's tiles are still held — the front grows, it does
    // not wander.
    adapter.applyFronts([{ province: 1, attacker: 1, progress: 0.5 }], controllers);
    const half = painted();
    expect(half.length).toBe(Math.floor(tiles.length * 0.5));
    for (const tile of quarter) expect(half).toContain(tile);

    // Pushed back to nothing: every tile is the defender's again.
    adapter.applyFronts([{ province: 1, attacker: 1, progress: 0 }], controllers);
    expect(painted()).toHaveLength(0);
  });

  test("a repaint of the base ownership does not erase the front", () => {
    const controllers = new Array<number>(idx.provinceCount).fill(1);
    controllers[1] = 2;
    adapter.applyFullState(controllers, 1);
    adapter.applyFronts([{ province: 1, attacker: 1, progress: 0.5 }], controllers);
    const before = [...idx.tilesOf(1)].filter(
      (tile) => adapter.frameData().tileState[tile] === 1,
    );
    expect(before.length).toBeGreaterThan(0);

    // A fresh full state paints province 1 back to its controller; applying
    // the fronts afterwards must restore exactly the same lead tiles.
    adapter.applyFullState(controllers, 2);
    adapter.applyFronts([{ province: 1, attacker: 1, progress: 0.5 }], controllers);
    const after = [...idx.tilesOf(1)].filter(
      (tile) => adapter.frameData().tileState[tile] === 1,
    );
    expect(after.sort()).toEqual(before.sort());
  });

  test("a front that vanishes from the wire is unwound", () => {
    const controllers = new Array<number>(idx.provinceCount).fill(1);
    controllers[1] = 2;
    adapter.applyFullState(controllers, 1);
    adapter.applyFronts([{ province: 1, attacker: 1, progress: 0.5 }], controllers);

    // The attack was called off: the next update simply has no front for the
    // province, and the tiles must go back to the defender.
    adapter.applyFronts([], controllers);
    for (const tile of idx.tilesOf(1)) {
      expect(adapter.frameData().tileState[tile]).toBe(2);
    }
  });

  test("relationMatrix is big enough for the size it declares", () => {
    const f = adapter.frameData();
    // BorderComputePass calls texSubImage2D with size x size; too small an
    // array raises a GL error and no JS exception, so borders just come out
    // wrong.
    expect(f.relationMatrix.length).toBeGreaterThanOrEqual(
      f.relationSize * f.relationSize,
    );
  });

  test("every required FrameData field is present and typed", () => {
    const f = adapter.frameData();
    expect(f.tileState).toBeInstanceOf(Uint16Array);
    expect(f.trailState).toBeInstanceOf(Uint16Array);
    expect(f.railroadState).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(f.revealedRailTiles)).toBe(true);
    expect(Array.isArray(f.attackRings)).toBe(true);
    expect(Array.isArray(f.nukeTelegraphs)).toBe(true);
    expect(Array.isArray(f.spiralRibbons)).toBe(true);
    expect(typeof f.railroadDirty).toBe("boolean");
    expect(typeof f.structuresDirty).toBe("boolean");
    expect(typeof f.relationsDirty).toBe("boolean");
    // min > max is the "nothing dirty" encoding; backwards uploads a garbage
    // row range every tick.
    expect(f.trailDirtyRowMin).toBeGreaterThan(f.trailDirtyRowMax);
  });
});

describe("ProvinceTileIndex", () => {
  test("covers every land tile exactly once", () => {
    const terrain = new Uint8Array(W * H);
    for (let i = 0; i < terrain.length; i++) if (i % 3 !== 0) terrain[i] = LAND;
    const partition = computeProvincePartition(terrain, W, H, SEEDS);
    const idx = new ProvinceTileIndex({
      provinceOfTile: partition.provinceOfTile,
      provinceCount: partition.count,
    });

    const seen = new Set<number>();
    for (let p = 0; p < idx.provinceCount; p++) {
      for (const tile of idx.tilesOf(p)) {
        expect(seen.has(tile)).toBe(false);
        seen.add(tile);
        expect(partition.provinceOfTile[tile]).toBe(p);
      }
    }
    const landTiles = [...terrain].filter((b) => (b & LAND) !== 0).length;
    expect(seen.size).toBe(landTiles);
  });

  test("returns an empty view for an unknown province", () => {
    const { idx } = index();
    expect(idx.tilesOf(-1)).toHaveLength(0);
    expect(idx.tilesOf(idx.provinceCount)).toHaveLength(0);
  });
});
