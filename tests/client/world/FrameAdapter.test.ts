import { beforeEach, describe, expect, test } from "vitest";
import type { FrameUploadTarget } from "../../../src/client/render/frame/Upload";
import { uploadFrameData } from "../../../src/client/render/frame/Upload";
import { FrameAdapter } from "../../../src/client/world/FrameAdapter";
import { ProvinceTileIndex } from "../../../src/client/world/ProvinceTileIndex";
import { computeProvinceGrid } from "../../../src/shared/map/ProvinceGrid";

const LAND = 0x80;
const W = 8;
const H = 4;
const CELL = 2;

/** All land, so every 2x2 cell is a province: 4 x 2 = 8 provinces of 4 tiles. */
function index(): ProvinceTileIndex {
  const terrain = new Uint8Array(W * H).fill(LAND);
  return new ProvinceTileIndex(computeProvinceGrid(terrain, W, H, CELL));
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

  beforeEach(() => {
    idx = index();
    adapter = new FrameAdapter(idx, 4);
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
    const grid = computeProvinceGrid(terrain, W, H, CELL);
    const idx = new ProvinceTileIndex(grid);

    const seen = new Set<number>();
    for (let p = 0; p < idx.provinceCount; p++) {
      for (const tile of idx.tilesOf(p)) {
        expect(seen.has(tile)).toBe(false);
        seen.add(tile);
        expect(grid.provinceOfTile[tile]).toBe(p);
      }
    }
    const landTiles = [...terrain].filter((b) => (b & LAND) !== 0).length;
    expect(seen.size).toBe(landTiles);
  });

  test("returns an empty view for an unknown province", () => {
    const idx = index();
    expect(idx.tilesOf(-1)).toHaveLength(0);
    expect(idx.tilesOf(idx.provinceCount)).toHaveLength(0);
  });
});
