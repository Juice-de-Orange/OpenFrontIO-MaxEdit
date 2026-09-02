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

import type {
  FrameData,
  NameEntry,
  PlayerState,
  UnitState,
} from "src/client/render/types";
import type { Province } from "src/shared/map/Province";
import {
  forcesOf,
  type DivisionLike,
  type FormationLike,
} from "./ForcesAdapter";
import { placeLabel, type Box } from "./LabelPlacement";
import type { ProvinceTileIndex } from "./ProvinceTileIndex";
import { structuresOf } from "./StructureAdapter";
import type { ZoneAnchors } from "./ZoneAnchors";

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

/**
 * A nation's label on the map, in tiles: the square root of the land it
 * holds, scaled down, between a size that is still legible and one that does
 * not cover half a continent. Rendering constants, not balance.
 */
const LABEL_SCALE = 4;
const LABEL_MIN = 6;
const LABEL_MAX = 40;

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

  /** The nation labels and the per-nation state `NamePass` reads, mutated in place. */
  private readonly names = new Map<string, NameEntry>();
  private readonly players = new Map<number, PlayerState>();

  /** One box per province, in tiles. Built once: the partition never moves. */
  private provinceBoxes: Box[] | null = null;

  /** The two halves of the icon map, merged by `publishIcons`. */
  private buildingIcons: ReadonlyMap<number, UnitState> = new Map();
  private forceIcons: ReadonlyMap<number, UnitState> = new Map();

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
      players: this.players,
      names: this.names,
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
    this.buildingIcons = structuresOf(buildings, controllers, this.index);
    this.publishIcons();
  }

  /**
   * Redraw this nation's own divisions, wings and fleets.
   *
   * Separate from the buildings because they change on different beats — a
   * building count moves on a delta, an army moves whenever the economy view
   * does — and both end up in the one `units` map the passes read.
   */
  applyForces(
    nation: number | null,
    divisions: readonly DivisionLike[],
    formations: readonly FormationLike[],
    anchors: ZoneAnchors,
  ): void {
    this.forceIcons = forcesOf(
      nation,
      divisions,
      formations,
      this.index,
      anchors,
    );
    this.publishIcons();
  }

  /** One map for the renderer: what is built, and what is standing on it. */
  private publishIcons(): void {
    const units = new Map<number, UnitState>(this.buildingIcons);
    for (const [id, unit] of this.forceIcons) units.set(id, unit);
    (this.frame as { units: ReadonlyMap<number, UnitState> }).units = units;
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

  /**
   * Put every nation's name on the map, over the largest province it holds.
   *
   * `NamePass` was inherited whole and drew nothing because `names` and
   * `players` were empty maps. It wants a label keyed by the header id
   * (`nation-${smallID}`, as `WorldClient` builds the renderer) with a
   * position and a size in tiles, and a `PlayerState` per nation of which it
   * reads two fields: `isAlive` and `troops`. A nation holding no province
   * is dead and its label goes; the troop line is switched off in the
   * render settings because this game has no such number to show there.
   * Both maps are the frame's own and are mutated in place (the header
   * comment's rule), so the pass's diff-and-lerp sees the same objects.
   */
  applyLabels(
    controllers: readonly number[],
    provinces: readonly Province[],
    nations: readonly { smallID: number; name?: string }[],
  ): void {
    const boxes = this.boxes();
    const land = new Map<number, number>();
    const reach = new Map<number, Box>();
    const largest = new Map<number, Province>();
    for (let id = 0; id < controllers.length; id++) {
      const nation = controllers[id];
      const province = provinces[id];
      if (nation <= 0 || province === undefined) continue;
      land.set(nation, (land.get(nation) ?? 0) + province.tileCount);
      const best = largest.get(nation);
      if (best === undefined || province.tileCount > best.tileCount) {
        largest.set(nation, province);
      }
      const box = boxes[id];
      const grown = reach.get(nation);
      if (grown === undefined) {
        reach.set(nation, { ...box });
      } else {
        grown.minX = Math.min(grown.minX, box.minX);
        grown.minY = Math.min(grown.minY, box.minY);
        grown.maxX = Math.max(grown.maxX, box.maxX);
        grown.maxY = Math.max(grown.maxY, box.maxY);
      }
    }
    for (const { smallID, name } of nations) {
      const key = `nation-${smallID}`;
      const home = largest.get(smallID);
      const box = reach.get(smallID);
      if (home === undefined || box === undefined) {
        this.names.delete(key);
        this.players.set(smallID, playerState(smallID, false, 0));
        continue;
      }
      const tiles = land.get(smallID) ?? 0;
      // **The largest rectangle that fits in the territory**, not the centre
      // of the largest province: a coastal nation's centre is in the sea and
      // a horseshoe's is in the hole (`LabelPlacement.ts`). The old rule is
      // the fallback for a shape the search finds nothing in — one province
      // narrower than the coarse grid, say.
      const placed = placeLabel({
        box,
        inside: (x, y) => this.tileState[y * this.grid.width + x] === smallID,
        nameLength: (name ?? "").length,
        minSize: LABEL_MIN,
        maxSize: LABEL_MAX,
      });
      const size =
        placed?.size ??
        Math.min(
          LABEL_MAX,
          Math.max(LABEL_MIN, Math.sqrt(tiles) / LABEL_SCALE),
        );
      this.names.set(key, {
        playerID: key,
        x: placed?.x ?? home.centre.x,
        // A third of the size up, as upstream placed it: the glyphs hang
        // below the anchor, so the visual centre is lower than the point.
        y: placed?.y ?? home.centre.y - size / 3,
        size,
      });
      this.players.set(smallID, playerState(smallID, true, tiles));
    }
  }

  /**
   * A bounding box per province, in tiles, built on first use.
   *
   * The partition is fixed for the life of the world, so this is computed
   * once over every land tile and then read; a nation's own box is the union
   * of the boxes of the provinces it holds, which is a walk over provinces
   * rather than over tiles on every label pass.
   */
  private boxes(): Box[] {
    if (this.provinceBoxes !== null) return this.provinceBoxes;
    const width = this.grid.width;
    const boxes: Box[] = [];
    for (let province = 0; province < this.index.provinceCount; province++) {
      const box: Box = {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      };
      const tiles = this.index.tilesOf(province);
      for (let i = 0; i < tiles.length; i++) {
        const x = tiles[i] % width;
        const y = (tiles[i] - x) / width;
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
      }
      boxes.push(box);
    }
    this.provinceBoxes = boxes;
    return boxes;
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

/**
 * The `PlayerState` the name pass reads two fields of. Everything else is
 * upstream's match bookkeeping — gold, betrayals, doomsday clocks — and is
 * zero here, once, rather than a second copy of a struct this game has no
 * source for.
 */
function playerState(
  smallID: number,
  isAlive: boolean,
  tilesOwned: number,
): PlayerState {
  return {
    smallID,
    isAlive,
    isDisconnected: false,
    killedBy: null,
    deathPosition: null,
    tilesOwned,
    gold: 0,
    tradeGold: 0,
    trainGold: 0,
    piracyGold: 0,
    goldEarned: 0,
    troops: 0,
    isTraitor: false,
    traitorRemainingTicks: 0,
    inDoomsdayClock: false,
    isDecaying: false,
    markedDoomsdayClockTick: 0,
    betrayals: 0,
    hasSpawned: isAlive,
    lastDeleteUnitTick: 0,
    allies: [],
    embargoes: [],
    targets: [],
    outgoingAttacks: [],
    incomingAttacks: [],
    outgoingAllianceRequests: [],
    alliances: [],
    outgoingEmojis: [],
  };
}
