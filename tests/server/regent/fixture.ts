/**
 * What every regent test needs: a world, a way to run one visit, and the
 * shortcuts that put a building, a division or a wing straight into the
 * state the way `Air.test` and `Naval.test` do.
 *
 * Seeds are searched, not chosen: a temperament is a function of the seed,
 * so a test that wants a builder or a marshal asks `seedFor` for the first
 * seed that makes one, and stays deterministic without depending on the
 * hash the temperament happens to use today.
 */

import { regentSystem } from "../../../src/server/systems/regent";
import {
  assess,
  type Situation,
} from "../../../src/server/systems/regent/situation";
import { World } from "../../../src/server/world/World";
import {
  applyEvent,
  type Formation,
  type WorldEvent,
  type WorldState,
} from "../../../src/server/world/WorldState";
import { DIVISION_MANPOWER } from "../../../src/shared/config/rates";
import { REGENT_INTERVAL_TICKS } from "../../../src/shared/config/regent";
import {
  nationIsCoastal,
  temperamentOf,
  type Temperament,
} from "../../../src/shared/config/temperament";
import {
  BUILDING_TYPES,
  buildingIndex,
  type BuildingType,
} from "../../../src/shared/economy/Buildings";
import { equipmentIndex } from "../../../src/shared/economy/Equipment";
import {
  FORMATIONS,
  type FormationTemplate,
  type Mission,
} from "../../../src/shared/economy/Formations";
import {
  islandFixture,
  mapFixture,
  type Fixture,
} from "../../util/worldFixture";

export interface Built {
  world: World;
  state: WorldState;
}

/** The five-nation land fixture every server test shares: no coast at all. */
export function landFixture(): Fixture {
  return mapFixture({
    width: 320,
    height: 140,
    capitals: [
      { x: 40, y: 40 },
      { x: 280, y: 40 },
      { x: 40, y: 100 },
      { x: 280, y: 100 },
      { x: 160, y: 70 },
    ],
  });
}

export function buildWorld(fixture: Fixture, seed: number): Built {
  const world = World.create(
    fixture.descriptor,
    fixture.nations,
    fixture.map,
    seed,
  );
  return { world, state: world.view() as WorldState };
}

export function landWorld(seed = 7): Built {
  return buildWorld(landFixture(), seed);
}

export function islandWorld(seed = 99): Built {
  return buildWorld(islandFixture(), seed);
}

/** The first seed whose temperament for `nation` satisfies the wish. */
export function seedFor(
  fixture: Fixture,
  nation: number,
  wish: (t: Temperament) => boolean,
  from = 1,
): number {
  const coastal = nationIsCoastal(fixture.map, nation);
  for (let seed = from; seed < from + 5000; seed++) {
    if (wish(temperamentOf(seed, nation, coastal))) return seed;
  }
  throw new Error("no seed in range makes that temperament");
}

/** Put a nation under the regent with men enough for the rules to act. */
export function steward(
  state: WorldState,
  nation: number,
  focus: WorldState["nations"][number]["regent"]["focus"] = "economy",
): void {
  state.nations[nation].regent.enabled = true;
  state.nations[nation].regent.focus = focus;
  state.nations[nation].manpower = DIVISION_MANPOWER * 40;
}

/** One regent visit: run at a thinking tick, apply what it decided. */
export function visit(state: WorldState): WorldEvent[] {
  const events = regentSystem.run(state, REGENT_INTERVAL_TICKS);
  for (const event of events) applyEvent(state, event);
  return events;
}

export function situation(state: WorldState, nation: number): Situation {
  return assess(state, nation, REGENT_INTERVAL_TICKS);
}

export function capitalOf(state: WorldState, nation: number): number {
  const found = state.map.provinces.find(
    (p) => p.capital && state.provinceController[p.id] === nation,
  );
  if (found === undefined) throw new Error(`nation ${nation} has no capital`);
  return found.id;
}

export function setBuilding(
  state: WorldState,
  province: number,
  building: BuildingType,
  count: number,
): void {
  state.buildings[province * BUILDING_TYPES.length + buildingIndex(building)] =
    count;
}

export function countOf(
  state: WorldState,
  province: number,
  building: BuildingType,
): number {
  return state.buildings[
    province * BUILDING_TYPES.length + buildingIndex(building)
  ];
}

/** A division at the given fraction of a full template. */
export function division(
  state: WorldState,
  nation: number,
  province: number,
  fill = 1,
): number {
  applyEvent(state, { kind: "division_raised", nation, province });
  const divisions = state.nations[nation].divisions;
  const raised = divisions[divisions.length - 1];
  if (raised === undefined) throw new Error("no division");
  raised.equipment[equipmentIndex("infantry_equipment")] = Math.round(
    100 * fill,
  );
  raised.equipment[equipmentIndex("artillery")] = Math.round(12 * fill);
  return raised.id;
}

/** A wing or fleet at the given fraction of its template, sent somewhere. */
export function formation(
  state: WorldState,
  nation: number,
  base: number,
  template: FormationTemplate,
  zone: number | null,
  mission: Mission | null,
  fill = 1,
): Formation {
  applyEvent(state, { kind: "formation_raised", nation, template, base });
  const formations = state.nations[nation].formations;
  const raised = formations[formations.length - 1];
  if (raised === undefined) throw new Error("no formation");
  applyEvent(state, {
    kind: "formation_equipment_changed",
    nation,
    formationId: raised.id,
    delta: Object.entries(FORMATIONS[template].equipment).map(
      ([type, wanted]) => [
        equipmentIndex(type as never),
        Math.round((wanted ?? 0) * fill),
      ],
    ) as [number, number][],
  });
  if (zone !== null && mission !== null) {
    applyEvent(state, {
      kind: "formation_assigned",
      nation,
      formationId: raised.id,
      zone,
      mission,
    });
  }
  return raised;
}

/**
 * Arm every division the nation has: the supply system's reinforcement,
 * done at once. A raised division is empty until the stockpile fills it,
 * and the garrison rule raises nothing new while one is hollow.
 */
export function fillArmy(state: WorldState, nation: number): void {
  for (const raised of state.nations[nation].divisions) {
    raised.equipment[equipmentIndex("infantry_equipment")] = 100;
    raised.equipment[equipmentIndex("artillery")] = 12;
  }
}

/** A province somebody else holds, next to one of `nation`'s. */
export function hostileNeighbourOf(state: WorldState, nation: number): number {
  const found = state.map.provinces.find(
    (p) =>
      state.provinceController[p.id] !== nation &&
      state.provinceController[p.id] > 0 &&
      p.neighbours.some((n) => state.provinceController[n] === nation),
  );
  if (found === undefined) throw new Error(`nation ${nation} has no border`);
  return found.id;
}

/** Finish everything in the queue at once — construction is not under test. */
export function finishQueue(state: WorldState, nation: number): void {
  const queue = state.nations[nation].constructionQueue;
  while (queue.length > 0) {
    const order = queue[0];
    applyEvent(state, {
      kind: "construction_finished",
      nation,
      index: 0,
      province: order.provinceId,
      building: order.building,
    });
  }
}

export function queued(
  events: WorldEvent[],
): { provinceId: number; building: BuildingType }[] {
  return events
    .filter((e) => e.kind === "construction_queued")
    .map(
      (e) =>
        (e as { order: { provinceId: number; building: BuildingType } }).order,
    );
}

export function ofKind<K extends WorldEvent["kind"]>(
  events: WorldEvent[],
  kind: K,
): Extract<WorldEvent, { kind: K }>[] {
  return events.filter((e) => e.kind === kind) as Extract<
    WorldEvent,
    { kind: K }
  >[];
}
