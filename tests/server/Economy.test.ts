import { beforeEach, describe, expect, test } from "vitest";
import { measureNation } from "../../src/server/systems/economy";
import { World } from "../../src/server/world/World";
import { countBuilding, usedSlots } from "../../src/server/world/WorldState";
import { RESOURCES } from "../../src/shared/config/provinces";
import {
  EQUIPMENT_MATERIALS,
  MILITARY_FACTORY_DEMAND,
  RESOURCE_CAP,
  STARTING_CAPITAL_BUILDINGS,
} from "../../src/shared/config/rates";
import { BUILDING_TYPES, BUILDINGS } from "../../src/shared/economy/Buildings";
import { mapFixture, type Fixture } from "../util/worldFixture";

/**
 * A fresh fixture per test, not one shared module-level constant.
 *
 * Two of the tests below strip a province's deposits to force a shortage, and
 * a shared `ProvinceMap` would carry that mutation into every test after them
 * — an order-dependent suite that passes today and fails the day somebody
 * adds a test above it. Building the map costs a couple of milliseconds.
 */
function build(): {
  world: World;
  map: Fixture["map"];
  nation: number;
  capital: number;
} {
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
  const capital = fixture.map.provinces.find((p) => p.capital);
  expect(capital, "the fixture has no capital province").toBeDefined();
  const found = capital as { id: number; nation: number };
  return {
    world: World.create(fixture.descriptor, fixture.nations, fixture.map),
    map: fixture.map,
    nation: found.nation,
    capital: found.id,
  };
}

describe("the economy system", () => {
  let world: World;
  let map: Fixture["map"];
  let nation: number;
  let capital: number;

  beforeEach(() => {
    ({ world, map, nation, capital } = build());
  });

  test("a capital starts with the factories the config gives it", () => {
    const province = capital;
    expect(countBuilding(world.view(), province, "civilian_factory")).toBe(
      STARTING_CAPITAL_BUILDINGS.civilian_factory,
    );
    expect(countBuilding(world.view(), province, "military_factory")).toBe(
      STARTING_CAPITAL_BUILDINGS.military_factory,
    );
    expect(usedSlots(world.view(), province)).toBe(
      STARTING_CAPITAL_BUILDINGS.civilian_factory +
        STARTING_CAPITAL_BUILDINGS.military_factory,
    );
  });

  test("construction points come from civilian factories and nothing else", () => {
    const economy = world.economyOf(nation);
    expect(economy.construction).toBeGreaterThan(0);

    // A nation with no capital has no factories, so no points. That is the
    // whole of "output comes from buildings" stated as a test.
    const withoutCapital = [
      ...new Set(map.provinces.map((p) => p.nation)),
    ].find((id) => !map.provinces.some((p) => p.capital && p.nation === id));
    if (withoutCapital !== undefined) {
      expect(world.economyOf(withoutCapital).construction).toBe(0);
    }
  });

  test("stockpiles move every tick, and never below zero or above the cap", () => {
    const before = { ...world.view().nations[nation].resources };
    for (let i = 0; i < 20; i++) world.step();
    const after = world.view().nations[nation].resources;

    let moved = false;
    for (const resource of RESOURCES) {
      expect(after[resource]).toBeGreaterThanOrEqual(0);
      expect(after[resource]).toBeLessThanOrEqual(RESOURCE_CAP);
      if (after[resource] !== before[resource]) moved = true;
    }
    // Invariant 1: a player who watches any number should see it move.
    expect(moved).toBe(true);
  });

  /**
   * Invariant 2, and the reason it is the most important rule in the game: a
   * player is never confronted with a wall, only with a number that got worse.
   */
  test("a resource shortage scales output down instead of blocking it", () => {
    const full = world.economyOf(nation);
    expect(full.sufficiency).toBe(1);
    expect(full.industry).toBeGreaterThan(0);
    expect(full.demand.steel).toBeGreaterThan(0);

    // Half of one tick's steel demand, and no mine to top it up.
    const state = world.view();
    for (const province of map.provinces) {
      if (state.provinceController[province.id] !== nation) continue;
      province.resourceDeposits.steel = undefined;
    }
    state.nations[nation].resources.steel = full.demand.steel / 2;

    const short = world.economyOf(nation);
    expect(short.sufficiency).toBeCloseTo(0.5, 6);
    // Scaled down, not switched off.
    expect(short.industry).toBeGreaterThan(0);
    expect(short.industry).toBeCloseTo(full.industry * 0.5, 6);

    // And construction is untouched: civilian factories draw no resources.
    expect(short.construction).toBe(full.construction);
  });

  test("running dry takes output to zero without breaking anything", () => {
    const state = world.view();
    for (const province of map.provinces) {
      if (state.provinceController[province.id] !== nation) continue;
      for (const resource of RESOURCES) {
        province.resourceDeposits[resource] = undefined;
      }
    }
    for (const resource of RESOURCES)
      state.nations[nation].resources[resource] = 0;

    const economy = world.economyOf(nation);
    expect(economy.sufficiency).toBe(0);
    expect(economy.industry).toBe(0);
    // The factories are still there and still counted; they are simply idle.
    expect(economy.demand.steel).toBeGreaterThan(0);
    expect(economy.construction).toBeGreaterThan(0);

    // And a tick over an empty stockpile does not go negative.
    world.step();
    for (const resource of RESOURCES) {
      expect(state.nations[nation].resources[resource]).toBeGreaterThanOrEqual(
        0,
      );
    }
  });

  test("a military factory draws exactly what the config says", () => {
    const economy = measureNation(world.view(), nation);
    expect(economy.demand.steel).toBeCloseTo(
      (MILITARY_FACTORY_DEMAND.steel ?? 0) *
        STARTING_CAPITAL_BUILDINGS.military_factory,
      9,
    );
  });
});

describe("the construction system", () => {
  let world: World;
  let map: Fixture["map"];
  let nation: number;
  let capital: number;

  beforeEach(() => {
    ({ world, map, nation, capital } = build());
  });

  function queue(building: "civilian_factory" | "supply_hub"): void {
    const command = {
      nation,
      body: {
        kind: "queue_construction" as const,
        provinceId: capital,
        building,
      },
    };
    expect(world.rejectionFor(command)).toBeNull();
    world.queueCommand(command);
    world.step();
  }

  test("progress accrues every tick and never arrives in a lump", () => {
    queue("supply_hub");
    const cost = BUILDINGS.supply_hub.cost;

    let previous = world.constructionQueueOf(nation)[0].progress;
    let finished = -1;
    for (let tick = 0; tick < 2000 && finished < 0; tick++) {
      const changes = world.step();
      const done = changes.buildings.length > 0;
      if (done) {
        finished = tick;
        break;
      }
      const order = world.constructionQueueOf(nation)[0];
      expect(
        order,
        "the queue emptied without finishing anything",
      ).toBeDefined();
      // Invariant 1: it moves, and it moves by a rate rather than a jump.
      expect(order.progress).toBeGreaterThan(previous);
      expect(order.progress - previous).toBeLessThan(cost / 2);
      previous = order.progress;
    }

    expect(finished, "nothing finished in 2000 ticks").toBeGreaterThan(0);
    expect(world.constructionQueueOf(nation)).toHaveLength(0);
    expect(countBuilding(world.view(), capital, "supply_hub")).toBe(1);
  });

  test("a finished civilian factory raises the nation's output", () => {
    const before = world.economyOf(nation).construction;
    queue("civilian_factory");
    for (let i = 0; i < 2000; i++) {
      world.step();
      if (world.constructionQueueOf(nation).length === 0) break;
    }
    expect(countBuilding(world.view(), capital, "civilian_factory")).toBe(
      STARTING_CAPITAL_BUILDINGS.civilian_factory + 1,
    );
    // The gate's "see it increase output", as a unit test.
    expect(world.economyOf(nation).construction).toBeGreaterThan(before);
  });

  test("cancelling takes it back out and loses the progress", () => {
    queue("supply_hub");
    for (let i = 0; i < 5; i++) world.step();
    expect(world.constructionQueueOf(nation)[0].progress).toBeGreaterThan(0);

    const cancel = {
      nation,
      body: {
        kind: "cancel_construction" as const,
        orderId: world.constructionQueueOf(nation)[0].id,
      },
    };
    expect(world.rejectionFor(cancel)).toBeNull();
    world.queueCommand(cancel);
    world.step();
    expect(world.constructionQueueOf(nation)).toHaveLength(0);
    expect(countBuilding(world.view(), capital, "supply_hub")).toBe(0);
  });

  test("the queue never exceeds the province's free slots", () => {
    const slots = map.provinces[capital].buildingSlots;
    const used = usedSlots(world.view(), capital);
    let accepted = 0;
    for (let i = 0; i < slots + 5; i++) {
      const command = {
        nation,
        body: {
          kind: "queue_construction" as const,
          provinceId: capital,
          building: "supply_hub" as const,
        },
      };
      if (world.rejectionFor(command) !== null) break;
      world.queueCommand(command);
      world.step();
      accepted++;
    }
    // Queued orders count against the slots, or a player spends a week of
    // points on buildings that can never be placed.
    expect(accepted).toBe(slots - used);
  });

  test("a dockyard is refused inland and a stranger's province is refused outright", () => {
    const inland = map.provinces.find((p) => p.nation === nation && !p.coastal);
    if (inland !== undefined) {
      expect(
        world.rejectionFor({
          nation,
          body: {
            kind: "queue_construction",
            provinceId: inland.id,
            building: "dockyard",
          },
        }),
      ).toMatch(/coastal/);
    }

    const theirs = map.provinces.find((p) => p.nation !== nation);
    expect(theirs).toBeDefined();
    expect(
      world.rejectionFor({
        nation,
        body: {
          kind: "queue_construction",
          provinceId: (theirs as { id: number }).id,
          building: "supply_hub",
        },
      }),
    ).not.toBeNull();
  });
});

/**
 * CLAUDE.md §9 asks every system for a test that runs it over a fixture world
 * for N ticks and asserts invariants. This is that test for phase 3's two: it
 * makes no assertion about what the economy *should* do, only about what it
 * must never do, and it checks all of them on every one of five hundred ticks.
 */
describe("five hundred ticks of invariants", () => {
  test("nothing ever goes negative, over cap, or past a limit", () => {
    const { world, map, nation } = build();
    const state = world.view();
    const stride = BUILDING_TYPES.length;

    // One nation is put into a permanent shortage on purpose. Left alone, no
    // nation in this fixture runs out of anything in five hundred ticks — and
    // then every "output was never blocked" count is zero for the wrong
    // reason, which is the shape of a green test that checks nothing. The
    // guard at the bottom is what caught it.
    for (const province of map.provinces) {
      if (province.nation !== nation) continue;
      province.resourceDeposits.steel = undefined;
    }
    state.nations[nation].resources.steel = 1;

    let slotOverruns = 0;
    let negative = 0;
    let overCap = 0;
    let overbuilt = 0;
    let longQueue = 0;
    let blocked = 0;
    let sufficiencyOutOfRange = 0;
    let sawShortage = false;

    for (let tick = 0; tick < 500; tick++) {
      world.step();

      for (
        let nation = 1;
        nation <= map.provinces.length && nation <= 5;
        nation++
      ) {
        const economy = world.economyOf(nation);
        if (economy.sufficiency < 0 || economy.sufficiency > 1) {
          sufficiencyOutOfRange++;
        }
        // Invariant 2: a shortage is a number that got worse. Output may only
        // be zero when there was nothing at all to work with.
        if (economy.sufficiency < 1) {
          sawShortage = true;
          if (economy.sufficiency > 0 && economy.industry <= 0) blocked++;
        }

        const nationState = state.nations[nation];
        for (const resource of RESOURCES) {
          const held = nationState.resources[resource];
          if (held < 0) negative++;
          if (held > RESOURCE_CAP) overCap++;
        }
        if (nationState.constructionQueue.length > 24) longQueue++;
        for (const order of nationState.constructionQueue) {
          // Progress never runs past the cost: the last tick takes only what
          // is still needed.
          if (order.progress > BUILDINGS[order.building].cost) overbuilt++;
          if (order.progress < 0) negative++;
        }
      }

      // Buildings never exceed the province's slots. Levels do not take one.
      for (const province of map.provinces) {
        let used = 0;
        for (let i = 0; i < stride; i++) {
          if (BUILDINGS[BUILDING_TYPES[i]].takesSlot) {
            used += state.buildings[province.id * stride + i];
          }
        }
        if (used > province.buildingSlots) slotOverruns++;
      }
    }

    expect(negative).toBe(0);
    expect(overCap).toBe(0);
    expect(overbuilt).toBe(0);
    expect(slotOverruns).toBe(0);
    expect(longQueue).toBe(0);
    expect(sufficiencyOutOfRange).toBe(0);
    expect(blocked).toBe(0);
    // Not an invariant — a guard against the test being vacuous. Without a
    // shortage somewhere in the run, `blocked` is zero because nothing was
    // ever tested.
    expect(sawShortage).toBe(true);
  });
});

/**
 * Decision 0009: what a factory draws depends on what it is making, and a
 * factory with no line to make anything for still draws the flat rate.
 *
 * The last of those is the one worth a test of its own. It is what keeps the
 * phase-3 gate — which builds nothing but unassigned factories and measures
 * exactly that flat draw — measuring the same thing it did before production
 * lines existed.
 */
describe("what a factory draws depends on what it makes", () => {
  let world: World;
  let nation: number;

  beforeEach(() => {
    ({ world, nation } = build());
  });

  function command(body: Parameters<World["rejectionFor"]>[0]["body"]): void {
    const full = { nation, body };
    expect(world.rejectionFor(full)).toBeNull();
    world.queueCommand(full);
    world.step();
  }

  function demand(): Record<string, number> {
    return measureNation(world.view(), nation).demand;
  }

  test("a factory on no line draws the flat rate", () => {
    const held = STARTING_CAPITAL_BUILDINGS.military_factory;
    expect(demand().steel).toBeCloseTo(
      (MILITARY_FACTORY_DEMAND.steel ?? 0) * held,
      9,
    );
  });

  test("a rifle line and a tank line of the same size are not the same drain", () => {
    command({
      kind: "create_production_line",
      equipment: "infantry_equipment",
    });
    const line = world.view().nations[nation].productionLines[0].id;
    command({ kind: "assign_factories", lineId: line, factories: 1 });

    const rifles = { ...demand() };
    expect(rifles.steel).toBeCloseTo(
      EQUIPMENT_MATERIALS.infantry_equipment.steel ?? 0,
      9,
    );

    command({
      kind: "switch_production_line",
      lineId: line,
      equipment: "armour",
    });
    const tanks = { ...demand() };

    expect(tanks.steel).toBeCloseTo(EQUIPMENT_MATERIALS.armour.steel ?? 0, 9);
    expect(tanks.steel).toBeGreaterThan(rifles.steel);
    // And it asks for things a rifle line never needed at all.
    expect(rifles.rubber).toBe(0);
    expect(tanks.rubber).toBeGreaterThan(0);
    expect(tanks.oil).toBeGreaterThan(0);
  });

  test("taking the factories off a line puts it back on the flat rate", () => {
    command({ kind: "create_production_line", equipment: "armour" });
    const line = world.view().nations[nation].productionLines[0].id;
    command({ kind: "assign_factories", lineId: line, factories: 1 });
    expect(demand().steel).toBeCloseTo(
      EQUIPMENT_MATERIALS.armour.steel ?? 0,
      9,
    );

    command({ kind: "assign_factories", lineId: line, factories: 0 });
    expect(demand().steel).toBeCloseTo(
      (MILITARY_FACTORY_DEMAND.steel ?? 0) *
        STARTING_CAPITAL_BUILDINGS.military_factory,
      9,
    );
  });
});
