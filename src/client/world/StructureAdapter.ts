/**
 * Turns the buildings a nation has built into the icons the renderer draws.
 *
 * `StructurePass`, `StructureLevelPass` and `BarPass` were inherited whole,
 * are constructed and enabled, and drew nothing for twelve phases because
 * nothing ever put a structure into `FrameData.units`. The building counts
 * have been on the wire and in the HUD model since phase 3; this is the one
 * missing line between them and the map — a factory the player can *see*,
 * which is what makes a construction queue feel like building something.
 *
 * **It lives in `world/`, not `render/`, and that is enforced**:
 * `tests/architecture/RenderBoundary.test.ts` forbids the renderer from
 * importing anything here, so this is a producer of `UnitState` and the
 * renderer stays a consumer of `FrameData`.
 *
 * Invariant 8 permits a tile position for a building explicitly, as long as
 * the tile is projection and never a target: the tile is chosen here from the
 * province's own tiles by a hash and no player action ever names it.
 */

import type { UnitState } from "src/client/render/types";
import {
  UT_CITY,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
} from "src/client/render/types/UnitType";
import {
  BUILDING_TYPES,
  buildingIndex,
  type BuildingType,
} from "src/shared/economy/Buildings";
import type { ProvinceTileIndex } from "./ProvinceTileIndex";

/**
 * Which inherited icon stands for which building.
 *
 * Six atlas columns for eight slot-taking types, and no asset pipeline: the
 * atlas is 384×64 of inherited binary and the generator its headers name has
 * never existed. So a dockyard and a naval base both look like a port, and
 * the refineries look like factories — ugly and deliberate. Whether the map
 * carries buildings at all is the question to answer before drawing icons.
 * Two columns are avoided on purpose: "Defense Post" darkens the territory
 * around it (DefenseCoveragePass) and would turn every supply hub into a
 * shadow. Infrastructure and extraction upgrades are levels on the province,
 * not things standing in it, and get no icon.
 */
export const STRUCTURE_ICON: Partial<Record<BuildingType, string>> = {
  civilian_factory: UT_CITY,
  military_factory: UT_FACTORY,
  synthetic_oil: UT_FACTORY,
  synthetic_rubber: UT_FACTORY,
  dockyard: UT_PORT,
  naval_base: UT_PORT,
  air_base: UT_SAM_LAUNCHER,
  supply_hub: UT_MISSILE_SILO,
};

/** A stable id per (province, building type); positive, since 0 reads as "none". */
export function structureId(province: number, type: BuildingType): number {
  return province * BUILDING_TYPES.length + buildingIndex(type) + 1;
}

/**
 * The tile an icon stands on: one of the province's own land tiles, picked
 * by a hash of (province, type) so it never moves between ticks and the
 * icons of one province do not all land on the same tile.
 *
 * Not `Province.centre`: that is a mean of the tiles and lies in the sea for
 * any crescent-shaped coast, where a factory in the water would be the first
 * thing a player noticed. `-1` for a province with no tiles.
 */
export function structureTile(
  index: ProvinceTileIndex,
  province: number,
  type: BuildingType,
): number {
  const tiles = index.tilesOf(province);
  if (tiles.length === 0) return -1;
  const mixed = Math.imul(
    (province + 1) * 0x9e3779b1 + (buildingIndex(type) + 1) * 0x85ebca6b,
    0x27d4eb2f,
  );
  return tiles[(mixed >>> 0) % tiles.length];
}

/**
 * Every building with an icon, as the `UnitState` the passes read.
 *
 * `level` is the count, which `StructureLevelPass` writes as a digit over the
 * icon — the per-province number wanted. `ownerID` is the controller, so an
 * occupied factory wears its occupier's colour, like its province does.
 * `markedForDeletion` is `false` and not `0`: both StructurePass and BarPass
 * test `!== false`, and `0` marks every building as being demolished.
 */
export function structuresOf(
  buildings: readonly number[],
  controllers: readonly number[],
  index: ProvinceTileIndex,
): Map<number, UnitState> {
  const units = new Map<number, UnitState>();
  const stride = BUILDING_TYPES.length;
  for (let province = 0; province < controllers.length; province++) {
    for (const type of BUILDING_TYPES) {
      const icon = STRUCTURE_ICON[type];
      if (icon === undefined) continue;
      const count = buildings[province * stride + buildingIndex(type)] ?? 0;
      if (count <= 0) continue;
      const pos = structureTile(index, province, type);
      if (pos < 0) continue;
      const id = structureId(province, type);
      units.set(id, {
        id,
        unitType: icon,
        ownerID: controllers[province],
        lastOwnerID: null,
        pos,
        lastPos: pos,
        isActive: true,
        reachedTarget: true,
        retreating: false,
        targetable: false,
        waitTicks: 0,
        markedForDeletion: false,
        health: null,
        underConstruction: false,
        targetUnitId: null,
        targetTile: null,
        troops: 0,
        missileTimerQueue: [],
        level: count,
        veterancy: 0,
        hasTrainStation: false,
        trainType: null,
        loaded: null,
        constructionStartTick: null,
        samUpgradeStartTick: null,
        samUpgradeStartRange: null,
        samUpgradeTargetLevel: null,
        samUpgradeDuration: null,
      });
    }
  }
  return units;
}
