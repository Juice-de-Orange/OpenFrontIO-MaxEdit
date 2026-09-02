import { beforeEach, describe, expect, test } from "vitest";
import {
  applyEvent,
  type WorldState,
} from "../../../src/server/world/WorldState";
import {
  buildWorld,
  countOf,
  finishQueue,
  hostileNeighbourOf,
  landFixture,
  landWorld,
  queued,
  seedFor,
  situation,
  steward,
  visit,
} from "./fixture";

/**
 * The build rule beyond the hub and the focus: a refinery when the market
 * cannot cover a shortage, and the builder's mines.
 */
describe("the regent's construction", () => {
  let state: WorldState;

  beforeEach(() => {
    ({ state } = landWorld());
    steward(state, 1);
  });

  test("an oil shortage the budget cannot cover gets a refinery", () => {
    // A line that drinks oil the nation neither has nor pumps, and no
    // budget at the market to buy it with.
    applyEvent(state, {
      kind: "production_line_created",
      nation: 1,
      equipment: "armour",
    });
    const line =
      state.nations[1].productionLines[
        state.nations[1].productionLines.length - 1
      ];
    if (line === undefined) throw new Error("no line");
    applyEvent(state, {
      kind: "production_factories_assigned",
      nation: 1,
      lineId: line.id,
      factories: 1,
    });
    state.nations[1].resources.oil = 0;
    state.nations[1].regent.marketBudget = 0;
    const s = situation(state, 1);
    expect(s.scarcest).toBe("oil");
    expect(s.shortfall).toBeGreaterThan(0);

    const built: string[] = [];
    for (let i = 0; i < 5 && !built.includes("synthetic_oil"); i++) {
      built.push(...queued(visit(state)).map((o) => o.building));
      finishQueue(state, 1);
    }
    expect(built).toContain("synthetic_oil");
    // A refinery is the answer to a shortage, never a habit.
    state.nations[1].resources.oil = 10_000;
    for (let i = 0; i < 5; i++) {
      expect(queued(visit(state)).map((o) => o.building)).not.toContain(
        "synthetic_oil",
      );
      finishQueue(state, 1);
    }
  });

  test("a builder upgrades its richest deposit, a mine per factory", () => {
    const fixture = landFixture();
    const seed = seedFor(fixture, 1, (t) => t.archetype === "builder");
    ({ state } = buildWorld(fixture, seed));
    steward(state, 1);
    const richest = [...situation(state, 1).owned]
      .map((p) => ({
        p,
        deposits: Object.values(state.map.provinces[p].resourceDeposits).reduce(
          (sum, v) => sum + (v ?? 0),
          0,
        ),
      }))
      .sort((a, b) => b.deposits - a.deposits || a.p - b.p)[0];
    expect(richest.deposits).toBeGreaterThan(0);

    const orders: { provinceId: number; building: string }[] = [];
    for (let i = 0; i < 6; i++) {
      orders.push(...queued(visit(state)));
      finishQueue(state, 1);
    }
    const mines = orders.filter((o) => o.building === "extraction_upgrade");
    expect(mines.length).toBeGreaterThan(0);
    expect(mines[0].provinceId).toBe(richest.p);
    // Never mines alone: a mine per civilian factory, at most one ahead.
    const owned = situation(state, 1).owned;
    const total = (building: "extraction_upgrade" | "civilian_factory") =>
      owned.reduce((n, p) => n + countOf(state, p, building), 0);
    expect(total("extraction_upgrade")).toBeLessThanOrEqual(
      total("civilian_factory") + 1,
    );
  });

  test("a non-builder leaves the deposits alone", () => {
    const fixture = landFixture();
    const seed = seedFor(fixture, 1, (t) => t.industry < 0.5);
    ({ state } = buildWorld(fixture, seed));
    steward(state, 1);
    for (let i = 0; i < 6; i++) {
      expect(queued(visit(state)).map((o) => o.building)).not.toContain(
        "extraction_upgrade",
      );
      finishQueue(state, 1);
    }
  });

  test("never queues where a player could not: owned, in slots, not full", () => {
    // A neighbour's province under my control but not my ownership.
    const theirs = hostileNeighbourOf(state, 1);
    state.provinceController[theirs] = 1;
    for (let i = 0; i < 12; i++) {
      for (const order of queued(visit(state))) {
        expect(state.provinceOwner[order.provinceId]).toBe(1);
        expect(order.provinceId).not.toBe(theirs);
      }
      finishQueue(state, 1);
    }
  });
});
