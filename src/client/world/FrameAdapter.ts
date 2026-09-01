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

import type { FrameData, UnitState } from "src/client/render/types";
import type { Province } from "src/shared/map/Province";
import type { ProvinceTileIndex } from "./ProvinceTileIndex";
import { structuresOf } from "./StructureAdapter";

/** Above this share of the map, a full upload beats a delta. */
const FULL_UPLOAD_FRACTION = 0.25;

/** What the adapter needs to know about the tile grid to paint a front. */
export interface FrontGrid {
  provinceOfTile: Int32Array;
  width: number;
  height: number;
}

/** One standing attack as the wire reports it. */
export interface FrontUpdate {
  province: number;
  attacker: number;
  progress: number;
}

/** One crossing under way as the wire reports it. */
export interface InvasionUpdate {
  attacker: number;
  to: number;
  ticksLeft: number;
}

/**
 * The pulsing circle over a beach an invasion is heading for, in tiles.
 * Rendering constants, not balance: nothing in the simulation reads them.
 */
const INVASION_MARK_INNER = 3;
const INVASION_MARK_OUTER = 9;

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
  /**
   * An edge, consumed by `frameData()`. Left true it rebuilds every building
   * instance a tick; left false it draws nothing after the first frame. Neither
   * says anything, which is why it is private and set in exactly one place.
   */
  private structuresDirty = false;

  private readonly frame: FrameData;

  /** Provinces whose tiles currently carry a partial front's colours. */
  private readonly frontedProvinces = new Set<number>();

  constructor(
    private readonly index: ProvinceTileIndex,
    private readonly grid: FrontGrid,
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

  /**
   * Redraw the buildings from the current counts and controllers.
   *
   * Call on the full state, and on a delta that moved a building count or a
   * controller (an occupied factory wears its occupier's colour). The map
   * is replaced, not mutated: the renderer rebuilds its instance buffer from
   * whatever it is handed while `structuresDirty` is set.
   */
  applyBuildings(
    buildings: readonly number[],
    controllers: readonly number[],
  ): void {
    (this.frame as { units: ReadonlyMap<number, UnitState> }).units =
      structuresOf(buildings, controllers, this.index);
    this.structuresDirty = true;
  }

  /**
   * Mark the war on the map: a ring over every contested province and a
   * pulsing circle over every beach an invasion is heading for.
   *
   * Both passes were inherited, enabled and fed nothing. The attack ring
   * fades itself in and out from local time and diffs by `unitId`, so a
   * stable id per province is all it needs; the telegraph pulses and takes
   * a self/enemy relation for its colour. Centres are fine here — a ring
   * over the sea beside a crescent coast still says where the province is,
   * where a factory in the water would not.
   */
  applyMarkers(
    fronts: readonly FrontUpdate[],
    invasions: readonly InvasionUpdate[],
    controllers: readonly number[],
    provinces: readonly Province[],
    nation: number | null,
  ): void {
    const rings = this.frame.attackRings;
    rings.length = 0;
    for (const front of fronts) {
      if (front.attacker === controllers[front.province]) continue;
      const province = provinces[front.province];
      if (province === undefined) continue;
      rings.push({
        x: province.centre.x,
        y: province.centre.y,
        unitId: front.province + 1,
      });
    }
    const marks = this.frame.nukeTelegraphs;
    marks.length = 0;
    for (const invasion of invasions) {
      const province = provinces[invasion.to];
      if (province === undefined) continue;
      marks.push({
        x: province.centre.x,
        y: province.centre.y,
        innerRadius: INVASION_MARK_INNER,
        outerRadius: INVASION_MARK_OUTER,
        relation: invasion.attacker === nation ? 0 : 2,
      });
    }
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

  /**
   * Paint every front's partial progress over the base ownership.
   *
   * Call after `applyFullState` or `applyDelta`, which paint whole provinces
   * in their controller's colour and would otherwise erase a front. The lead
   * tiles — `progress × tileCount`, ordered by breadth-first distance from
   * the attacking border — take the attacker's colour; the rest are put back
   * to the controller's, which is also what unwinds a front that shrank or
   * ended. Only tiles whose value actually changed enter `changedTiles`.
   *
   * The province's *controller* is untouched: tiles are a projection
   * (decision 0002), and a contested province still belongs to its defender
   * everywhere the game can see (invariant 8).
   */
  applyFronts(
    fronts: readonly FrontUpdate[],
    controllers: readonly number[],
  ): void {
    const seen = new Set<number>();
    for (const front of fronts) {
      const controller = controllers[front.province];
      // The tick a march completes, the wire can briefly carry both the new
      // controller and the spent front; painting it would colour the whole
      // province as "contested by its own controller".
      if (front.attacker === controller) continue;
      seen.add(front.province);
      this.paintFront(front, controller, controllers);
    }
    for (const province of [...this.frontedProvinces]) {
      if (!seen.has(province)) {
        this.paintChecked(province, controllers[province]);
        this.frontedProvinces.delete(province);
      }
    }
  }

  private paintFront(
    front: FrontUpdate,
    controller: number,
    controllers: readonly number[],
  ): void {
    const tiles = this.index.tilesOf(front.province);
    const count = Math.floor(front.progress * tiles.length);
    if (count <= 0 && !this.frontedProvinces.has(front.province)) return;

    const order = this.frontOrder(front.province, front.attacker, controllers);
    for (let i = 0; i < order.length; i++) {
      const wanted = i < count ? front.attacker : controller;
      const tile = order[i];
      if (this.tileState[tile] !== wanted) {
        this.tileState[tile] = wanted;
        this.changedTiles.push(tile);
      }
    }
    if (count > 0) this.frontedProvinces.add(front.province);
    else this.frontedProvinces.delete(front.province);
  }

  /** Repaint a whole province, pushing only the tiles that actually moved. */
  private paintChecked(province: number, owner: number): void {
    const tiles = this.index.tilesOf(province);
    for (let i = 0; i < tiles.length; i++) {
      if (this.tileState[tiles[i]] !== owner) {
        this.tileState[tiles[i]] = owner;
        this.changedTiles.push(tiles[i]);
      }
    }
  }

  /**
   * The province's tiles, nearest-to-the-attacker first.
   *
   * A breadth-first flood from the tiles that touch the attacker's own
   * territory, so the province fills from the border the attack comes over —
   * which is where the front actually is. Recomputed per call rather than
   * cached: a province is a few hundred tiles, there are a handful of fronts,
   * and the attacking border moves as the war does.
   */
  private frontOrder(
    province: number,
    attacker: number,
    controllers: readonly number[],
  ): Int32Array {
    const { provinceOfTile, width } = this.grid;
    const tiles = this.index.tilesOf(province);
    const order = new Int32Array(tiles.length);
    const queued = new Set<number>();
    let filled = 0;

    const borders = (tile: number, wantAttacker: boolean): boolean => {
      const x = tile % width;
      const neighbours = [
        x > 0 ? tile - 1 : -1,
        x < width - 1 ? tile + 1 : -1,
        tile - width,
        tile + width,
      ];
      for (const next of neighbours) {
        if (next < 0 || next >= provinceOfTile.length) continue;
        const other = provinceOfTile[next];
        if (other === province || other < 0) continue;
        if (!wantAttacker) return true;
        // The neighbour's *controller*, not its painted colour: the
        // neighbouring province may itself be mid-front.
        if (controllers[other] === attacker) return true;
      }
      return false;
    };

    // Seeds: tiles touching a province the attacker's colour is on. If the
    // attacker holds nothing adjacent any more, fall back to the province's
    // whole edge — the front is stale and about to end, but until the server
    // says so it still has to be drawn somewhere honest.
    for (const tile of tiles) {
      if (borders(tile, true)) {
        order[filled++] = tile;
        queued.add(tile);
      }
    }
    if (filled === 0) {
      for (const tile of tiles) {
        if (borders(tile, false)) {
          order[filled++] = tile;
          queued.add(tile);
        }
      }
    }

    // Breadth-first: the order array doubles as the queue.
    for (let read = 0; read < filled && filled < tiles.length; read++) {
      const tile = order[read];
      const x = tile % width;
      const neighbours = [
        x > 0 ? tile - 1 : -1,
        x < width - 1 ? tile + 1 : -1,
        tile - width,
        tile + width,
      ];
      for (const next of neighbours) {
        if (next < 0 || next >= provinceOfTile.length) continue;
        if (provinceOfTile[next] !== province || queued.has(next)) continue;
        order[filled++] = next;
        queued.add(next);
      }
    }

    // Disconnected pockets (or no seeds at all): append in raster order.
    if (filled < tiles.length) {
      for (const tile of tiles) {
        if (!queued.has(tile)) order[filled++] = tile;
      }
    }
    return order;
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
      structuresDirty: boolean;
    };
    f.tick = this.tick;
    f.changedTiles = this.wantFullUpload ? null : this.changedTiles;
    this.wantFullUpload = false;
    f.structuresDirty = this.structuresDirty;
    this.structuresDirty = false;
    return this.frame;
  }
}
