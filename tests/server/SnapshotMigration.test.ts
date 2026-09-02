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
  "dockyard",
  "synthetic_oil",
  "synthetic_rubber",
  "air_base",
  "naval_base",
  "supply_hub",
  "infrastructure",
  "extraction_upgrade",
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
    // Old index 0,1,2 keep their places; 5..9 shift down by two.
    expect(held("civilian_factory")).toBe(1);
    expect(held("military_factory")).toBe(2);
    expect(held("dockyard")).toBe(3);
    expect(held("air_base")).toBe(6);
    expect(held("naval_base")).toBe(7);
    expect(held("supply_hub")).toBe(8);
    expect(held("infrastructure")).toBe(9);
    expect(held("extraction_upgrade")).toBe(10);
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
