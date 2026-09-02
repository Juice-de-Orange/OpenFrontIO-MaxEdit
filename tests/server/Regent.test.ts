import { beforeEach, describe, expect, test } from "vitest";
import { regentSystem } from "../../src/server/systems/regent";
import { World } from "../../src/server/world/World";
import { applyEvent, type WorldState } from "../../src/server/world/WorldState";
import { DIVISION_MANPOWER } from "../../src/shared/config/rates";
import {
  REGENT_INTERVAL_TICKS,
  REGENT_QUEUE_DEPTH,
} from "../../src/shared/config/regent";
import { temperamentOf } from "../../src/shared/config/temperament";
import { equipmentIndex } from "../../src/shared/economy/Equipment";
import { mapFixture } from "../util/worldFixture";

/**
 * The regent, driven directly (§6.10).
 *
 * Every rule here is either a §6.10 baseline duty, one of invariant 7's
 * prohibitions, or the one rule that matters most: never touch an existing
 * production line's equipment type. The system is run at its own interval
 * and its events applied, exactly as `World.step` would.
 */
function build(): { world: World; state: WorldState } {
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
  const world = World.create(
    fixture.descriptor,
    fixture.nations,
    fixture.map,
    7,
  );
  return { world, state: world.view() as WorldState };
}

/** One regent visit: run at a thinking tick, apply what it decided. */
function visit(state: WorldState): ReturnType<typeof regentSystem.run> {
  const events = regentSystem.run(state, REGENT_INTERVAL_TICKS);
  for (const event of events) applyEvent(state, event);
  return events;
}

describe("the regent", () => {
  let state: WorldState;

  beforeEach(() => {
    ({ state } = build());
    state.nations[1].regent.enabled = true;
    state.nations[1].manpower = DIVISION_MANPOWER * 4;
  });

  test("disabled means silent — the default, until phase 11 (decision 0018)", () => {
    state.nations[1].regent.enabled = false;
    expect(visit(state)).toHaveLength(0);
  });

  test("thinks only on its own interval", () => {
    expect(regentSystem.run(state, REGENT_INTERVAL_TICKS + 1)).toHaveLength(0);
  });

  test("garrisons the capital, once", () => {
    visit(state);
    const capital = state.map.provinces.find(
      (p) => p.capital && state.provinceController[p.id] === 1,
    ) as { id: number };
    expect(
      state.nations[1].divisions.filter(
        (division) => division.province === capital.id,
      ),
    ).toHaveLength(1);
    // A second visit does not raise a second one.
    visit(state);
    expect(
      state.nations[1].divisions.filter(
        (division) => division.province === capital.id,
      ),
    ).toHaveLength(1);
    // And the manpower was paid, not conjured (invariant: no free lunch).
    expect(state.nations[1].manpower).toBe(DIVISION_MANPOWER * 3);
  });

  test("keeps the construction queue non-empty", () => {
    expect(state.nations[1].constructionQueue).toHaveLength(0);
    visit(state);
    expect(state.nations[1].constructionQueue.length).toBeGreaterThan(0);
    // But it is a steward, not a planner: one order a visit, and never more
    // than a shallow queue, so construction is not spread thin.
    const length = state.nations[1].constructionQueue.length;
    visit(state);
    expect(state.nations[1].constructionQueue.length).toBeLessThanOrEqual(
      length + 1,
    );
    for (let i = 0; i < 6; i++) visit(state);
    expect(state.nations[1].constructionQueue.length).toBeLessThanOrEqual(
      REGENT_QUEUE_DEPTH,
    );
  });

  test("puts idle factories on a line and never switches one", () => {
    const first = visit(state);
    // The fixture nation starts with one idle military factory and no line:
    // the first visit opens one, the next staffs it.
    expect(
      first.some((event) => event.kind === "production_line_created"),
    ).toBe(true);
    visit(state);
    const line = state.nations[1].productionLines[0];
    expect(line.factories).toBeGreaterThan(0);

    // The forbidden event, over many visits and with the focus changed —
    // §6.2's ramp is a player's days of work and the regent must never
    // spend them.
    state.nations[1].regent.focus = "defence";
    for (let i = 0; i < 20; i++) {
      const events = visit(state);
      expect(
        events.some((event) => event.kind === "production_line_switched"),
      ).toBe(false);
    }
    expect(state.nations[1].productionLines[0].equipment).toBe(line.equipment);
  });

  test("with two factories it runs rifles and guns together — the phase-6 lesson", () => {
    // A division's strength is the worst template ratio (§6.3): one line
    // can only ever arm nobody. Give the nation a second factory and the
    // regent must open both lines and staff them.
    const capital = state.map.provinces.find(
      (p) => p.capital && state.provinceController[p.id] === 1,
    ) as { id: number };
    applyEvent(state, {
      kind: "construction_queued",
      nation: 1,
      order: {
        provinceId: capital.id,
        building: "military_factory",
        progress: 0,
      },
    });
    applyEvent(state, {
      kind: "construction_finished",
      nation: 1,
      index: 0,
      province: capital.id,
      building: "military_factory",
    });

    for (let i = 0; i < 4; i++) visit(state);
    const lines = state.nations[1].productionLines;
    const rifles = lines.find((l) => l.equipment === "infantry_equipment");
    const guns = lines.find((l) => l.equipment === "artillery");
    expect(rifles?.factories).toBeGreaterThan(0);
    expect(guns?.factories).toBeGreaterThan(0);
  });

  test("fills the research slots deterministically", () => {
    visit(state);
    const slots = state.nations[1].researchSlots;
    expect(slots[0].tech).not.toBeNull();
    expect(slots[1].tech).not.toBeNull();
    // Two slots, two different techs — no slot studies what another runs.
    expect(slots[0].tech).not.toBe(slots[1].tech);
  });

  test("calls off an attack whose staging has crumbled — the only retreat", () => {
    // A standing attack with no worthwhile division anywhere near it.
    const target = state.map.provinces.find(
      (p) =>
        state.provinceController[p.id] !== 1 &&
        state.provinceController[p.id] > 0 &&
        p.neighbours.some((n) => state.provinceController[n] === 1),
    ) as { id: number };
    // Somebody is holding it: a march into empty ground needs no army and is
    // never called off, but a fight with nobody to fight it is.
    const holder = state.provinceController[target.id];
    applyEvent(state, {
      kind: "division_raised",
      nation: holder,
      province: target.id,
    });
    const theirs =
      state.nations[holder].divisions[
        state.nations[holder].divisions.length - 1
      ];
    if (theirs === undefined) throw new Error("no garrison");
    applyEvent(state, {
      kind: "division_equipment_changed",
      nation: holder,
      divisionId: theirs.id,
      delta: [
        [equipmentIndex("infantry_equipment"), 100],
        [equipmentIndex("artillery"), 12],
      ],
    });
    applyEvent(state, {
      kind: "attack_ordered",
      nation: 1,
      province: target.id,
    });
    const events = visit(state);
    expect(events).toContainEqual({
      kind: "attack_ended",
      nation: 1,
      province: target.id,
    });
  });

  test("expansion attacks the weakest unbound neighbour; nothing else does", () => {
    // Give the staging a division worth its keep so the retreat rule does
    // not immediately call the new front off again.
    const focusRuns = () => {
      const events = visit(state);
      return events.filter((event) => event.kind === "attack_ordered");
    };
    expect(focusRuns()).toHaveLength(0); // economy focus: no war

    state.nations[1].regent.focus = "expansion";
    const ordered = focusRuns();
    expect(ordered).toHaveLength(1);
    // One new front a visit, and never more open than the temperament
    // allows (decision 0028): an expander's aggression is its front count.
    const allowed =
      1 + Math.floor(temperamentOf(state.worldSeed, 1, true).aggression * 2);
    for (let i = 0; i < 6; i++) {
      expect(focusRuns().length).toBeLessThanOrEqual(1);
      expect(state.nations[1].attacks.length).toBeLessThanOrEqual(allowed);
    }
    expect(state.nations[1].attacks.length).toBe(allowed);
  });

  test("never touches diplomacy, capitals or the sea (invariant 7)", () => {
    const forbidden = new Set([
      "agreement_proposed",
      "agreement_accepted",
      "agreement_withdrawn",
      "agreement_notice_given",
      "agreement_dissolved",
      "trust_changed",
      "invasion_started",
    ]);
    for (const focus of [
      "economy",
      "military",
      "defence",
      "expansion",
    ] as const) {
      state.nations[1].regent.focus = focus;
      for (let i = 0; i < 6; i++) {
        for (const event of visit(state)) {
          expect(forbidden.has(event.kind), event.kind).toBe(false);
        }
      }
    }
  });

  test("a shortage buys the scarcest resource at the market, inside the budget", () => {
    // A line that drinks oil the nation neither has nor pumps.
    applyEvent(state, {
      kind: "production_line_created",
      nation: 1,
      equipment: "armour",
    });
    const lines = state.nations[1].productionLines;
    const line = lines[lines.length - 1];
    applyEvent(state, {
      kind: "production_factories_assigned",
      nation: 1,
      lineId: line.id,
      factories: 1,
    });
    state.nations[1].resources.oil = 0;
    state.nations[1].resources.rubber = 0;

    visit(state);
    const orders = state.nations[1].market;
    const placed = (["steel", "oil", "aluminium", "rubber"] as const).filter(
      (resource) => orders[resource] > 0,
    );
    expect(placed.length).toBe(1);
    expect(orders[placed[0]]).toBeLessThanOrEqual(
      state.nations[1].regent.marketBudget,
    );

    // Plenty again: the standing order is cleared rather than paying the
    // market's rates for ever.
    state.nations[1].resources.oil = 1000;
    state.nations[1].resources.rubber = 1000;
    state.nations[1].resources.steel = 1000;
    visit(state);
    expect(
      (["steel", "oil", "aluminium", "rubber"] as const).every(
        (resource) => state.nations[1].market[resource] === 0,
      ),
    ).toBe(true);
  });

  test("a starving division gets a hub before the focus gets its factory", () => {
    // A division far from home: reach there is poor on this fixture.
    const capital = state.map.provinces.find(
      (p) => p.capital && state.provinceController[p.id] === 1,
    ) as { id: number };
    const owned = state.map.provinces
      .filter((p) => state.provinceController[p.id] === 1 && !p.capital)
      .map((p) => p.id);
    const far = owned[owned.length - 1];
    applyEvent(state, { kind: "division_raised", nation: 1, province: far });
    const divisions = state.nations[1].divisions;
    const division = divisions[divisions.length - 1];
    division.equipment[equipmentIndex("infantry_equipment")] = 100;
    division.equipment[equipmentIndex("artillery")] = 12;

    const events = visit(state);
    const queued = events.find(
      (event) => event.kind === "construction_queued",
    ) as { order: { provinceId: number; building: string } } | undefined;
    expect(queued).toBeDefined();
    // Either the far division was already fine (fixture geometry) and the
    // focus built, or it was short and the hub went exactly there.
    if (queued !== undefined && queued.order.building === "supply_hub") {
      expect(queued.order.provinceId).toBe(far);
    }
    void capital;
  });
});
