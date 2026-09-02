/**
 * Turns a nation's own army, wings and fleets into icons on the map.
 *
 * Until now the forces were rows of numbers in a panel: "3 divisions", "a
 * fighter wing over zone 22". A player had nothing to point at. These are
 * the same drawing problem as a factory standing in a province — an icon on
 * a coloured plate with a number over it — so they ride the atlas and the
 * passes the buildings already use (`StructureAdapter` is the sibling), and
 * the only new thing is where each one stands.
 *
 * **Own forces only.** The wire sends a nation its own `economy`, and other
 * nations' armies are not in it (§7: what a session may see). Drawing what
 * the server does not send would be inventing it.
 *
 * Where each stands:
 * - a **division** on a tile of the province it is in, hashed by its id so
 *   two divisions in one province do not sit on top of each other;
 * - a **wing or fleet** on its zone's anchor tile (`ZoneAnchors`), which is
 *   the middle of the area it is assigned to — and at its base when it is
 *   standing down, because that is where it actually is.
 *
 * The number over the icon is the unit's own number, which is what a player
 * calls it: "the 3rd division". Strength is the plate's health bar, not a
 * digit — a percentage over a 44-pixel icon reads as noise.
 */

import type { UnitState } from "src/client/render/types";
import {
  UT_DIVISION,
  UT_FLEET,
  UT_WING,
} from "src/client/render/types/UnitType";
import {
  FORMATIONS,
  type FormationTemplate,
} from "src/shared/economy/Formations";
import type { ProvinceTileIndex } from "./ProvinceTileIndex";
import type { ZoneAnchors } from "./ZoneAnchors";

/** What the adapter needs of a division; the wire's `DivisionView`. */
export interface DivisionLike {
  id: number;
  provinceId: number;
  strength: number;
}

/** What it needs of a formation; the wire's `FormationView`. */
export interface FormationLike {
  id: number;
  template: FormationTemplate;
  baseProvinceId: number;
  zone: number | null;
  strength: number;
}

/** Ids of forces start above every structure id, so the two never collide. */
export const FORCE_ID_BASE = 1_000_000;

/** A stable id for a division's icon. */
export function divisionIconId(id: number): number {
  return FORCE_ID_BASE + id;
}

/** A stable id for a formation's icon. */
export function formationIconId(id: number): number {
  return FORCE_ID_BASE * 2 + id;
}

/**
 * A tile of the province for this unit, spread by its id.
 *
 * The same reasoning as a building's tile: the province centre is a mean and
 * lies in the sea for a crescent coast, and two divisions on one tile look
 * like one division.
 */
function tileFor(
  index: ProvinceTileIndex,
  province: number,
  salt: number,
): number {
  const tiles = index.tilesOf(province);
  if (tiles.length === 0) return -1;
  const mixed = Math.imul(
    (province + 1) * 0x7feb352d + salt * 0x9e3779b1,
    0x846ca68b,
  );
  return tiles[(mixed >>> 0) % tiles.length];
}

/** The digit over an icon: at most two, which is what the pass can draw. */
function label(id: number): number {
  return Math.max(1, Math.min(99, id));
}

function icon(
  id: number,
  unitType: string,
  owner: number,
  pos: number,
  level: number,
  strength: number,
): UnitState {
  return {
    id,
    unitType,
    ownerID: owner,
    lastOwnerID: null,
    pos,
    lastPos: pos,
    isActive: true,
    reachedTarget: true,
    retreating: false,
    targetable: false,
    waitTicks: 0,
    markedForDeletion: false,
    // 0..1 on the plate's bar: an under-equipped division looks under-equipped.
    health: Math.max(0, Math.min(1, strength)),
    underConstruction: false,
    targetUnitId: null,
    targetTile: null,
    troops: 0,
    missileTimerQueue: [],
    level,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
  };
}

/**
 * Every one of this nation's forces that has a place on the map.
 *
 * A division at sea (`provinceId` -1, §6.8's crossing) is left out: the
 * invasion already has its own pulsing marker on the beach it is heading
 * for, and a counter in the middle of the ocean would say less than that.
 */
export function forcesOf(
  nation: number | null,
  divisions: readonly DivisionLike[],
  formations: readonly FormationLike[],
  index: ProvinceTileIndex,
  anchors: ZoneAnchors,
): Map<number, UnitState> {
  const units = new Map<number, UnitState>();
  if (nation === null) return units;

  for (const division of divisions) {
    if (division.provinceId < 0) continue;
    const pos = tileFor(index, division.provinceId, division.id);
    if (pos < 0) continue;
    const id = divisionIconId(division.id);
    units.set(
      id,
      icon(id, UT_DIVISION, nation, pos, label(division.id), division.strength),
    );
  }

  for (const formation of formations) {
    const spec = FORMATIONS[formation.template];
    if (spec === undefined) continue;
    const air = spec.kind === "air";
    const anchor =
      formation.zone === null
        ? undefined
        : (air ? anchors.air : anchors.sea).get(formation.zone);
    const pos =
      anchor ?? tileFor(index, formation.baseProvinceId, formation.id);
    if (pos < 0) continue;
    const id = formationIconId(formation.id);
    units.set(
      id,
      icon(
        id,
        air ? UT_WING : UT_FLEET,
        nation,
        pos,
        label(formation.id),
        formation.strength,
      ),
    );
  }

  return units;
}
