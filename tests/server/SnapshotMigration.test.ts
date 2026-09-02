import { describe, expect, test } from "vitest";
import { World } from "../../src/server/world/World";
import { RESOURCE_CAP } from "../../src/shared/config/rates";
import {
  BUILDING_TYPES,
  buildingIndex,
} from "../../src/shared/economy/Buildings";
import { mapFixture } from "../util/worldFixture";

/**
 * A world in flight when the game got simpler (decision 0029).
 *
 * Four resources became one and the two synthetic refineries left the
 * building list, which moves every index in a province's building row. A
 * straight copy of an old snapshot would silently turn every air base into a
 * supply hub and every stockpile into a quarter of itself, so the restore
 * translates instead — that is what decision 0016's hash versioning is for,
 * and this is the test that it works rather than merely runs.
 */
function build(): World {
  const fixture = mapFixture({
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
  return World.create(fixture.descriptor, fixture.nations, fixture.map);
}

/** The old building order, before the refineries went. */
const OLD_TYPES = [
  "civilian_factory",
  "military_factory",
  "military_factory",
  "synthetic_oil",
  "synthetic_rubber",
  "air_base",
  "naval_base",
  "supply_hub",
  "infrastructure",
  "infrastructure",
] as const;

describe("a snapshot from before the simplification", () => {
  test("its buildings land in the right slots, and the refineries are dropped", () => {
    const world = build();
    const fresh = world.snapshot();
    const provinces = world.view().map.provinces.length;

    // Rebuild the buildings array in the old shape: one of everything in
    // province 0, so a mis-indexed restore cannot hide behind a zero.
    const old = new Array<number>(provinces * OLD_TYPES.length).fill(0);
    for (let i = 0; i < OLD_TYPES.length; i++) old[i] = i + 1;

    const restored = build();
    restored.restoreFrom({
      ...fresh,
      hashVersion: 6,
      buildings: old,
      nations: fresh.nations.map((nation) => ({
        ...nation,
        resources: {
          steel: 100,
          oil: 40,
          aluminium: 30,
          rubber: 10,
        } as never,
        market: { steel: 0.5, oil: 0.25 } as never,
      })),
    });

    const state = restored.view();
    const held = (type: (typeof BUILDING_TYPES)[number]): number =>
      state.buildings[0 * BUILDING_TYPES.length + buildingIndex(type)];
    // Two migrations run in a row on a snapshot this old: the refineries
    // leave (0029), then the dockyard folds onto the military factory and
    // the extraction upgrade goes (0032). So civilian keeps its 1, military
    // is its own 2 plus the dockyard's 3, and the rest shift down.
    expect(held("civilian_factory")).toBe(1);
    expect(held("military_factory")).toBe(5);
    expect(held("air_base")).toBe(6);
    expect(held("naval_base")).toBe(7);
    expect(held("supply_hub")).toBe(8);
    expect(held("infrastructure")).toBe(9);
  });

  test("four stockpiles become the one, and the market order with them", () => {
    const world = build();
    const fresh = world.snapshot();
    const restored = build();
    restored.restoreFrom({
      ...fresh,
      hashVersion: 6,
      nations: fresh.nations.map((nation) => ({
        ...nation,
        resources: {
          steel: 100,
          oil: 40,
          aluminium: 30,
          rubber: 10,
        } as never,
        market: { steel: 0.5, oil: 0.25 } as never,
      })),
    });
    // The same wealth, counted once rather than four times.
    expect(restored.view().nations[1].resources.material).toBe(180);
    expect(restored.view().nations[1].market.material).toBeCloseTo(0.75);
  });

  test("a pile over the cap is clamped rather than kept", () => {
    const world = build();
    const fresh = world.snapshot();
    const restored = build();
    restored.restoreFrom({
      ...fresh,
      hashVersion: 6,
      nations: fresh.nations.map((nation) => ({
        ...nation,
        resources: {
          steel: 4000,
          oil: 4000,
          aluminium: 4000,
          rubber: 4000,
        } as never,
      })),
    });
    expect(restored.view().nations[1].resources.material).toBe(RESOURCE_CAP);
  });

  test("ten equipment types fold into three, and five templates into two", () => {
    const world = build();
    const fresh = world.snapshot();
    const restored = build();
    // The old order: rifles, guns, armour, fighters, bombers, transports,
    // convoys, submarines, escorts, capital ships.
    const kit = [10, 20, 30, 4, 5, 6, 1, 2, 3, 4];
    restored.restoreFrom({
      ...fresh,
      hashVersion: 7,
      nations: fresh.nations.map((nation) => ({
        ...nation,
        stockpile: [...kit],
        productionLines: [
          {
            id: 1,
            equipment: "fighter" as never,
            factories: 2,
            efficiency: 0.5,
          },
        ],
        divisions: [{ id: 1, province: 0, equipment: [...kit] }],
        formations: [
          {
            id: 1,
            template: "battle_fleet" as never,
            base: 0,
            zone: 3,
            mission: "convoy_escort" as never,
            equipment: [...kit],
          },
        ],
      })),
    });

    const nation = restored.view().nations[1];
    // infantry = rifles + guns + armour + transports; aircraft = the two
    // aircraft; ships = the four hulls.
    expect(nation.stockpile).toEqual([66, 9, 10]);
    expect(nation.productionLines[0].equipment).toBe("aircraft");
    expect(nation.divisions[0].equipment).toEqual([66, 9, 10]);
    expect(nation.formations[0].template).toBe("fleet");
    expect(nation.formations[0].mission).toBe("patrol");
    // And the ramp it had earned is not thrown away by the translation.
    expect(nation.productionLines[0].efficiency).toBe(0.5);
  });

  test("a snapshot this build wrote itself is not touched", () => {
    const world = build();
    world.view().nations[1].resources.material = 123;
    const snapshot = world.snapshot();
    expect(snapshot.hashVersion).toBeGreaterThanOrEqual(7);
    const restored = build();
    restored.restoreFrom(snapshot);
    expect(restored.view().nations[1].resources.material).toBe(123);
    expect(restored.stateHash()).toBe(world.stateHash());
  });
});
