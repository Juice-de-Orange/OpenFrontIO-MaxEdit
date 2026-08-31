import { beforeEach, describe, expect, test } from "vitest";
import { World } from "../../src/server/world/World";
import { divisionStrength } from "../../src/server/world/WorldState";
import {
  DIVISION_MANPOWER,
  EFFICIENCY_DECAY,
  EFFICIENCY_FLOOR,
  EFFICIENCY_GAIN,
} from "../../src/shared/config/rates";
import {
  DIVISION_TEMPLATE,
  equipmentIndex,
  type EquipmentType,
} from "../../src/shared/economy/Equipment";
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

describe("production lines", () => {
  let world: World;
  let nation: number;

  beforeEach(() => {
    ({ world, nation } = build());
  });

  function lineOf() {
    const lines = world.view().nations[nation].productionLines;
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  function command(body: Parameters<World["rejectionFor"]>[0]["body"]): void {
    const full = { nation, body };
    expect(world.rejectionFor(full)).toBeNull();
    world.queueCommand(full);
    world.step();
  }

  function openLine(): number {
    command({
      kind: "create_production_line",
      equipment: "infantry_equipment",
    });
    const id = lineOf().id;
    // One military factory in the capital is what a nation starts with, so
    // one is what a line can have.
    command({ kind: "assign_factories", lineId: id, factories: 1 });
    return id;
  }

  test("a new line starts empty, at the floor, and makes nothing", () => {
    command({
      kind: "create_production_line",
      equipment: "infantry_equipment",
    });
    expect(lineOf().efficiency).toBe(EFFICIENCY_FLOOR);
    expect(lineOf().factories).toBe(0);
    expect(
      world.view().nations[nation].stockpile[
        equipmentIndex("infantry_equipment")
      ],
    ).toBe(0);
  });

  test("a line with factories produces and climbs", () => {
    openLine();
    const before = lineOf().efficiency;
    for (let i = 0; i < 20; i++) world.step();

    expect(lineOf().efficiency).toBeGreaterThan(before);
    expect(
      world.view().nations[nation].stockpile[
        equipmentIndex("infantry_equipment")
      ],
    ).toBeGreaterThan(0);
  });

  /**
   * §6.2, and the mechanic the whole game's pace rests on. A player who
   * commits to producing one thing massively out-produces one who reacts —
   * because reacting costs them this.
   */
  test("switching what a line makes throws the ramp away", () => {
    const id = openLine();
    for (let i = 0; i < 200; i++) world.step();

    const earned = lineOf().efficiency;
    expect(earned).toBeGreaterThan(EFFICIENCY_FLOOR + 100 * EFFICIENCY_GAIN);

    command({
      kind: "switch_production_line",
      lineId: id,
      equipment: "artillery",
    });
    expect(lineOf().equipment).toBe("artillery");
    // At the floor, plus at most the one tick of climbing the line did after
    // the switch landed: commands apply before the systems run, so a line
    // reset on tick N is already producing artillery badly on tick N.
    expect(lineOf().efficiency).toBeLessThanOrEqual(
      EFFICIENCY_FLOOR + EFFICIENCY_GAIN,
    );
    expect(lineOf().efficiency).toBeGreaterThanOrEqual(EFFICIENCY_FLOOR);
    // The factories stay where they were: it is the type that costs, not the
    // reallocation.
    expect(lineOf().factories).toBe(1);
  });

  /** The other half of the same rule, and the one a player relies on. */
  test("moving factories on and off a line does not", () => {
    const id = openLine();
    for (let i = 0; i < 200; i++) world.step();

    const earned = lineOf().efficiency;
    expect(earned).toBeGreaterThan(EFFICIENCY_FLOOR + 100 * EFFICIENCY_GAIN);

    command({ kind: "assign_factories", lineId: id, factories: 0 });
    command({ kind: "assign_factories", lineId: id, factories: 1 });

    // Not "unchanged": an idle line decays, slowly and on purpose, and those
    // two commands took two ticks of it. What must not happen is the reset.
    expect(lineOf().efficiency).toBeGreaterThan(EFFICIENCY_FLOOR);
    expect(earned - lineOf().efficiency).toBeLessThan(4 * EFFICIENCY_DECAY);
  });

  test("a nation cannot put more factories on lines than it holds", () => {
    command({
      kind: "create_production_line",
      equipment: "infantry_equipment",
    });
    expect(
      world.rejectionFor({
        nation,
        body: { kind: "assign_factories", lineId: lineOf().id, factories: 99 },
      }),
    ).toMatch(/military factories/);
  });

  test("switching a line to what it already makes is refused, not ignored", () => {
    command({
      kind: "create_production_line",
      equipment: "infantry_equipment",
    });
    expect(
      world.rejectionFor({
        nation,
        body: {
          kind: "switch_production_line",
          lineId: lineOf().id,
          equipment: "infantry_equipment",
        },
      }),
    ).toMatch(/already makes/);
  });
});

describe("divisions and the stockpile", () => {
  let world: World;
  let nation: number;
  let capital: number;

  beforeEach(() => {
    ({ world, nation, capital } = build());
  });

  /**
   * Manpower, without waiting for it.
   *
   * It regrows at a fraction of a cap that depends on land the nation both
   * owns and holds — and the border drift moves that every tick, so waiting
   * for it here would measure the drift rather than the mechanic. That the
   * pool grows toward its cap at all has its own test below.
   */
  function giveManpower(): void {
    world.view().nations[nation].manpower = DIVISION_MANPOWER * 2;
  }

  function raise(): void {
    giveManpower();
    const command = {
      nation,
      body: { kind: "raise_division" as const, provinceId: capital },
    };
    expect(world.rejectionFor(command)).toBeNull();
    world.queueCommand(command);
    world.step();
  }

  function fillStockpile(multiple: number): void {
    const stockpile = world.view().nations[nation].stockpile;
    for (const [type, wanted] of Object.entries(DIVISION_TEMPLATE)) {
      stockpile[equipmentIndex(type as EquipmentType)] =
        (wanted ?? 0) * multiple;
    }
  }

  test("raising a division costs manpower and starts it empty", () => {
    giveManpower();
    const before = world.view().nations[nation].manpower;
    raise();

    const divisions = world.view().nations[nation].divisions;
    expect(divisions).toHaveLength(1);
    expect(world.view().nations[nation].manpower).toBeLessThan(before);
    // Raised empty and weak, not conjured at full strength (§6.3).
    expect(divisionStrength(divisions[0])).toBe(0);
  });

  test("a division draws from the stockpile and gets stronger", () => {
    raise();
    fillStockpile(5);
    const state = world.view();

    const before = divisionStrength(state.nations[nation].divisions[0]);
    for (let i = 0; i < 30; i++) world.step();
    const after = divisionStrength(state.nations[nation].divisions[0]);

    expect(after).toBeGreaterThan(before);
    // And the stockpile went down by what the division took.
    expect(
      state.nations[nation].stockpile[equipmentIndex("infantry_equipment")],
    ).toBeLessThan((DIVISION_TEMPLATE.infantry_equipment ?? 0) * 5);
  });

  test("manpower grows toward what the nation's land supports", () => {
    const state = world.view();
    state.nations[nation].manpower = 0;
    expect(world.militaryView(nation, 1).manpowerCap).toBeGreaterThan(0);

    for (let i = 0; i < 200; i++) world.step();
    expect(state.nations[nation].manpower).toBeGreaterThan(0);

    // Never past the ceiling — measured against the highest ceiling the run
    // ever had, because the border drift moves provinces between the tick the
    // economy reads the cap and the tick it is compared against.
    let highest = 0;
    for (let i = 0; i < 1000; i++) {
      highest = Math.max(highest, world.militaryView(nation, 1).manpowerCap);
      world.step();
      expect(state.nations[nation].manpower).toBeLessThanOrEqual(
        highest + 1e-6,
      );
    }
  });

  test("no division is ever stronger than its template", () => {
    raise();
    fillStockpile(100);
    const state = world.view();

    for (let i = 0; i < 400; i++) {
      world.step();
      for (const division of state.nations[nation].divisions) {
        expect(divisionStrength(division)).toBeLessThanOrEqual(1);
      }
    }
  });
});
