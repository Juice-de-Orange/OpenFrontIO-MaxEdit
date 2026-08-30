/**
 * Turns province ownership into the FrameData the renderer reads.
 *
 * This is the only place in the world client that writes `tileState`, which
 * is what makes "the client derives no state" checkable: the store knows
 * provinces and not tiles, the tile index knows tiles and not owners, and
 * only this file sees both.
 *
 * **It owns the long-lived buffers, and that is load-bearing.** The renderer
 * keeps references and reads them at draw time — TrailPass holds
 * `liveTrailRef`, RailroadPass holds `liveRailroadRef`. Allocating a fresh
 * array per tick renders the first frame correctly and then silently ignores
 * every update, with no error anywhere. They are allocated once here and
 * mutated in place.
 *
 * `changedTiles` is the exception and may be reused: TerritoryPass copies the
 * ref and the tile value into its drip buckets immediately. Two opposite rules
 * in the same object, which is exactly why the trap is a trap.
 */

import type { FrameData } from "src/client/render/types";
import type { ProvinceTileIndex } from "./ProvinceTileIndex";

/** Above this share of the map, a full upload beats a delta. */
const FULL_UPLOAD_FRACTION = 0.25;

export class FrameAdapter {
  private readonly tileState: Uint16Array;
  private readonly trailState: Uint16Array;
  private readonly railroadState: Uint8Array;
  private readonly relationMatrix: Uint8Array;
  private readonly revealedRailTiles: number[] = [];
  private readonly changedTiles: number[] = [];
  private readonly fullUploadThreshold: number;

  private tick = 0;
  /** null on the next frame() means "full upload". */
  private wantFullUpload = true;

  private readonly frame: FrameData;

  constructor(
    private readonly index: ProvinceTileIndex,
    nationCount: number,
  ) {
    const tiles = index.tileCount;
    this.tileState = new Uint16Array(tiles);
    this.trailState = new Uint16Array(tiles);
    this.railroadState = new Uint8Array(tiles);
    this.fullUploadThreshold = Math.floor(tiles * FULL_UPLOAD_FRACTION);

    // Relation matrix is (n+1)^2 so slot 0 (unowned) has a row.
    const size = nationCount + 1;
    this.relationMatrix = new Uint8Array(size * size);

    this.frame = {
      tick: 0,
      inSpawnPhase: false,
      tileState: this.tileState,
      trailState: this.trailState,
      railroadState: this.railroadState,
      units: new Map(),
      players: new Map(),
      names: new Map(),
      // Three empty arrays, not an empty object: Upload.ts reads `.length`
      // on each of these before checking anything else.
      events: { deadUnits: [], conquestEvents: [], bonusEvents: [] },
      changedTiles: null,
      railroadDirty: false,
      revealedRailTiles: this.revealedRailTiles,
      // min > max means "no trail rows dirty".
      trailDirtyRowMin: 1,
      trailDirtyRowMax: -1,
      spiralRibbons: [],
      playerStatus: new Map(),
      relationMatrix: this.relationMatrix,
      relationSize: size,
      relationsDirty: false,
      allianceClusters: new Map(),
      nukeTelegraphs: [],
      attackRings: [],
      structuresDirty: false,
    };
  }

  /** Paint every province from scratch; the next frame is a full upload. */
  applyFullState(owners: readonly number[], tick: number): void {
    this.tick = tick;
    this.tileState.fill(0);
    for (let province = 0; province < owners.length; province++) {
      this.paint(province, owners[province]);
    }
    this.changedTiles.length = 0;
    this.wantFullUpload = true;
  }

  /** Apply owner changes; the next frame carries just those tiles. */
  applyDelta(changes: readonly [number, number][], tick: number): void {
    this.tick = tick;
    if (this.wantFullUpload) {
      // A delta arriving before the pending full upload was drawn: fold it in
      // and stay on the full path rather than emitting a delta the renderer
      // would apply on top of a texture it has not received yet.
      for (const [province, owner] of changes) this.paint(province, owner);
      return;
    }

    this.changedTiles.length = 0;
    let touched = 0;
    for (const [province] of changes) {
      touched += this.index.tilesOf(province).length;
    }

    if (touched > this.fullUploadThreshold) {
      for (const [province, owner] of changes) this.paint(province, owner);
      this.wantFullUpload = true;
      return;
    }

    for (const [province, owner] of changes) {
      const tiles = this.index.tilesOf(province);
      for (let i = 0; i < tiles.length; i++) {
        this.tileState[tiles[i]] = owner;
        this.changedTiles.push(tiles[i]);
      }
    }
  }

  private paint(province: number, owner: number): void {
    const tiles = this.index.tilesOf(province);
    for (let i = 0; i < tiles.length; i++) {
      this.tileState[tiles[i]] = owner;
    }
  }

  /**
   * The same FrameData object every time, with its fields updated.
   *
   * Returning a fresh object would be safe for the renderer's own copies but
   * defeats the point of the long-lived buffers above.
   */
  frameData(): FrameData {
    const f = this.frame as {
      tick: number;
      changedTiles: readonly number[] | null;
    };
    f.tick = this.tick;
    f.changedTiles = this.wantFullUpload ? null : this.changedTiles;
    this.wantFullUpload = false;
    return this.frame;
  }
}
