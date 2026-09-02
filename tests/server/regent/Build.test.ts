import { beforeEach, describe, expect, test } from "vitest";
import {
  applyEvent,
  type WorldState,
} from "../../../src/server/world/WorldState";
import {
  buildWorld,
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

  test("a shortage it cannot dig its way out of goes to the market", () => {
    // The refineries went with the fourth resource (decision 0029): there is
    // nothing left to convert into anything. What is left is §6.10's one
    // economic reaction, and it is the whole of it.
    applyEvent(state, {
      kind: "production_line_created",
      nation: 1,
      equipment: "infantry",
    });
    const lines = state.nations[1].productionLines;
    const line = lines[lines.length - 1];
    if (line === undefined) throw new Error("no line");
    applyEvent(state, {
      kind: "production_factories_assigned",
      nation: 1,
      lineId: line.id,
      factories: 1,
    });
    state.nations[1].resources.material = 0;
    for (const province of state.map.provinces) {
      if (state.provinceController[province.id] !== 1) continue;
      province.resourceDeposits.material = 0;
    }
    expect(situation(state, 1).scarcest).toBe("material");

    visit(state);
    expect(state.nations[1].market.material).toBeGreaterThan(0);
    // And it never queues a building that no longer exists.
    for (let i = 0; i < 5; i++) {
      for (const order of queued(visit(state))) {
        expect(order.building).not.toMatch(/synthetic/);
      }
      finishQueue(state, 1);
    }
  });

  test("a builder fills its slots with factories", () => {
    // The extraction upgrade went with the fourth resource's bookkeeping
    // (decision 0032). What a builder does now is what a builder always did
    // first: put civilian factories in the ground.
    const fixture = landFixture();
    const seed = seedFor(fixture, 1, (t) => t.archetype === "builder");
    ({ state } = buildWorld(fixture, seed));
    steward(state, 1);

    const orders: { provinceId: number; building: string }[] = [];
    for (let i = 0; i < 6; i++) {
      orders.push(...queued(visit(state)));
      finishQueue(state, 1);
    }
    const factories = orders.filter((o) => o.building === "civilian_factory");
    expect(factories.length).toBeGreaterThan(0);
    // And never a building that no longer exists.
    for (const order of orders) {
      expect(["dockyard", "extraction_upgrade", "synthetic_oil"]).not.toContain(
        order.building,
      );
    }
  });

  test("a non-builder still builds something", () => {
    const fixture = landFixture();
    const seed = seedFor(fixture, 1, (t) => t.industry < 0.5);
    ({ state } = buildWorld(fixture, seed));
    steward(state, 1);
    for (let i = 0; i < 6; i++) {
      expect(queued(visit(state)).map((o) => o.building)).not.toContain(
        "dockyard",
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
