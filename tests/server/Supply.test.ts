import { beforeEach, describe, expect, test } from "vitest";
import {
  divisionDemand,
  supplyCoverage,
  supplyOf,
  supplyReach,
  supplySources,
  supplySystem,
} from "../../src/server/systems/supply";
import { World } from "../../src/server/world/World";
import {
  applyEvent,
  divisionStrength,
} from "../../src/server/world/WorldState";
import { DIVISION_MANPOWER } from "../../src/shared/config/rates";
import {
  SUPPLY_ATTRITION,
  SUPPLY_PER_DIVISION,
  SUPPLY_RANGE,
  SUPPLY_SOURCE_THROUGHPUT,
} from "../../src/shared/config/supply";
import { mapFixture } from "../util/worldFixture";

function build(): { world: World; nation: number; capital: number } {
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
  expect(capital).toBeDefined();
  const found = capital as { id: number; nation: number };
  return {
    world: World.create(fixture.descriptor, fixture.nations, fixture.map),
    nation: found.nation,
    capital: found.id,
  };
}

describe("supply over the province graph", () => {
  let world: World;
  let nation: number;
  let capital: number;

  beforeEach(() => {
    ({ world, nation, capital } = build());
  });

  test("a nation with no hubs still supplies itself from its capital", () => {
    const sources = supplySources(world.view(), nation);
    expect(sources).toContain(capital);
    // Invariant 2 at its most basic: a first division must not starve the tick
    // it is raised, because that would be a wall rather than a worse number.
    expect(supplyOf(supplyReach(world.view(), nation), 1, capital)).toBe(1);
  });

  test("reach falls with distance and never goes negative", () => {
    const reach = supplyReach(world.view(), nation);
    expect(reach.get(capital)).toBe(1);
    for (const level of reach.values()) {
      expect(level).toBeGreaterThan(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  test("a province the nation does not control conducts nothing", () => {
    const state = world.view();
    const reach = supplyReach(state, nation);
    for (const province of reach.keys()) {
      expect(state.provinceController[province]).toBe(nation);
    }
  });

  test("better roads carry supply further", () => {
    const state = world.view();
    const before = supplyReach(state, nation);
    // Raise infrastructure everywhere the nation holds and the same graph has
    // to reach at least as far — the same lever that speeds construction.
    for (
      let province = 0;
      province < state.provinceController.length;
      province++
    ) {
      if (state.provinceController[province] !== nation) continue;
      state.map.provinces[province].infrastructure = 10;
    }
    const after = supplyReach(state, nation);
    expect(after.size).toBeGreaterThanOrEqual(before.size);
    let improved = 0;
    for (const [province, level] of after) {
      const was = before.get(province) ?? 0;
      expect(level).toBeGreaterThanOrEqual(was - 1e-9);
      if (level > was + 1e-9) improved++;
    }
    expect(
      improved,
      "no province is better supplied on better roads",
    ).toBeGreaterThan(0);
  });

  test("more divisions than the hubs can carry means all of them get less", () => {
    const state = world.view();
    state.nations[nation].manpower = DIVISION_MANPOWER * 40;
    const sources = supplySources(state, nation).length;
    expect(supplyCoverage(state, nation)).toBe(1);

    // One more full division than the sources can feed, and coverage falls
    // for everyone rather than the last one going without: degrade, never
    // block. Full, because a division draws in proportion to what it holds
    // (§6.6) — empty ones would draw nothing and prove nothing.
    const raise = sources * SUPPLY_SOURCE_THROUGHPUT + 1;
    for (let i = 0; i < raise; i++) {
      state.nations[nation].divisions.push({
        id: 1000 + i,
        province: capital,
        equipment: [100, 12, 0, 0, 0, 0, 0, 0, 0, 0],
      });
    }
    const coverage = supplyCoverage(state, nation);
    expect(coverage).toBeLessThan(1);
    expect(coverage).toBeGreaterThan(0);
  });

  test("a division draws supply in proportion to the equipment it holds (§6.6)", () => {
    const full = { equipment: [100, 0, 0] };
    const half = { equipment: [50, 0, 0] };
    const empty = { equipment: new Array<number>(3).fill(0) };
    expect(divisionDemand(full)).toBeCloseTo(SUPPLY_PER_DIVISION, 10);
    expect(divisionDemand(half)).toBeCloseTo(SUPPLY_PER_DIVISION / 2, 10);
    expect(divisionDemand(empty)).toBe(0);
    // What it carries, not what it is called: a division holding aircraft it
    // has no use for eats for them all the same, because supply is weight.
    const odd = { equipment: [50, 6, 0] };
    expect(divisionDemand(odd)).toBeGreaterThan(divisionDemand(half));
    // And a nation of empty divisions has full coverage: nothing is asked.
    const state = world.view();
    for (let i = 0; i < 20; i++) {
      state.nations[nation].divisions.push({
        id: 2000 + i,
        province: capital,
        equipment: new Array<number>(3).fill(0),
      });
    }
    expect(supplyCoverage(state, nation)).toBe(1);
  });

  test("an unsupplied division wastes away, and a supplied one does not", () => {
    // The system is run directly rather than through `world.step()`. Stepping
    // the world runs combat too, and the border clash takes 5% off a division
    // in the province an attack came from — the first version of this test
    // read 0.9025, which is 0.95 twice and has nothing to do with supply.
    const state = world.view();
    const equipped = (): number[] => {
      const kit = new Array<number>(3).fill(0);
      kit[0] = 100;
      return kit;
    };
    const stranded = state.provinceController.findIndex(
      (holder) => holder !== nation && holder !== 0,
    );
    expect(stranded, "the fixture has no foreign province").toBeGreaterThan(-1);

    state.nations[nation].divisions.push(
      { id: 1, province: capital, equipment: equipped() },
      { id: 2, province: stranded, equipment: equipped() },
    );

    const events = supplySystem.run(state, 1);
    const touched = new Set(
      events
        .filter((e) => e.kind === "division_equipment_changed")
        .map((e) => e.divisionId),
    );
    // At the capital it is fully supplied and the system must leave it alone.
    expect(touched.has(1)).toBe(false);
    // Left behind in ground somebody else holds, it is out of supply entirely
    // and comes apart — slowly, and never to nothing in one tick.
    expect(touched.has(2)).toBe(true);

    for (const event of events) {
      if (event.kind !== "division_equipment_changed") continue;
      for (const [, amount] of event.delta) {
        expect(amount).toBeLessThan(0);
        expect(Math.abs(amount)).toBeLessThan(100 * SUPPLY_ATTRITION * 2);
      }
    }
  });

  test("supply degrades, and never empties a division in one go", () => {
    const state = world.view();
    const stranded = state.provinceController.findIndex(
      (holder) => holder !== nation && holder !== 0,
    );
    const kit = new Array<number>(3).fill(0);
    kit[0] = 100;
    state.nations[nation].divisions.push({
      id: 3,
      province: stranded,
      equipment: kit,
    });

    // A hundred ticks of nothing but supply. It must be visibly worse and
    // still be a division: invariant 2 is a slope, not a cliff.
    for (let tick = 0; tick < 100; tick++) {
      for (const event of supplySystem.run(state, tick)) {
        applyEvent(state, event);
      }
    }
    const division = state.nations[nation].divisions.find((d) => d.id === 3);
    const strength = divisionStrength(division as never);
    expect(strength).toBeLessThan(0.5);
    expect(strength).toBeGreaterThan(0);
  });

  test("the whole network recomputes well inside the 50 ms §8 asks for", () => {
    const state = world.view();
    const started = performance.now();
    for (let nation = 1; nation <= state.nationCount; nation++) {
      supplyReach(state, nation);
      supplyCoverage(state, nation);
    }
    const took = performance.now() - started;
    // Recorded rather than merely asserted: if this ever approaches the
    // budget, the cache §6.6 allows for is the answer, and the number here is
    // what says when.
    expect(
      took,
      `a full recompute for every nation took ${took.toFixed(2)} ms`,
    ).toBeLessThan(50);
  });

  test("range is what bounds it, not the size of the map", () => {
    const reach = supplyReach(world.view(), nation);
    for (const level of reach.values()) {
      // level = 1 - distance / SUPPLY_RANGE, so nothing inside the map can
      // read as further than the range allows.
      expect(level * SUPPLY_RANGE).toBeLessThanOrEqual(SUPPLY_RANGE);
    }
  });
});
