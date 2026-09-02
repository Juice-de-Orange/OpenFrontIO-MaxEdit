import path from "node:path";
import { describe, expect, test } from "vitest";
import { regentSystem } from "../../../src/server/systems/regent";
import { World } from "../../../src/server/world/World";
import type { WorldState } from "../../../src/server/world/WorldState";
import { DIVISION_MANPOWER } from "../../../src/shared/config/rates";
import { REGENT_INTERVAL_TICKS } from "../../../src/shared/config/regent";
import { landWorld, steward, visit } from "./fixture";

/**
 * Two promises the whole design rests on: the regent reaches the same
 * conclusions in a replay (§6, "the tick stays reproducible from the log"),
 * and it does so inside the tick's budget for every nation on the real map.
 */
describe("the regent is deterministic and cheap", () => {
  test("two worlds from one seed decide the same, visit after visit", () => {
    const a = landWorld(11);
    const b = landWorld(11);
    for (const { state } of [a, b]) {
      for (let nation = 1; nation <= state.nationCount; nation++) {
        steward(
          state,
          nation,
          (["economy", "military", "defence", "expansion"] as const)[
            nation % 4
          ],
        );
      }
    }
    for (let i = 0; i < 40; i++) {
      expect(visit(b.state)).toEqual(visit(a.state));
    }
    expect(b.world.stateHash()).toBe(a.world.stateHash());
  });

  test("a stepped world with regents everywhere replays to the same hash", () => {
    const a = landWorld(23);
    const b = landWorld(23);
    for (const { state } of [a, b]) {
      for (let nation = 1; nation <= state.nationCount; nation++) {
        steward(state, nation, nation % 2 === 0 ? "expansion" : "military");
      }
    }
    for (let tick = 0; tick < REGENT_INTERVAL_TICKS * 20; tick++) {
      a.world.step();
      b.world.step();
    }
    expect(b.world.stateHash()).toBe(a.world.stateHash());
    // And the regents did play: somebody raised an army and a queue.
    const armies = a.state.nations
      .slice(1)
      .reduce((n, nation) => n + nation.divisions.length, 0);
    expect(armies).toBeGreaterThan(0);
  });

  test("all fifty-two nations of Europe think inside the tick's budget", async () => {
    const world = await World.load(
      "europe",
      path.resolve(__dirname, "../../../resources"),
      5,
    );
    const state = world.view() as WorldState;
    for (let nation = 1; nation <= state.nationCount; nation++) {
      state.nations[nation].regent.enabled = true;
      state.nations[nation].manpower = DIVISION_MANPOWER * 20;
    }
    expect(state.nationCount).toBe(52);
    // A first visit warms the caches every system shares. The suite runs
    // its files in parallel, so a single reading is mostly load; the best
    // of five is the number a running world pays every twelve ticks
    // (about 13 ms on the machine this was written on).
    visit(state);
    let took = Number.POSITIVE_INFINITY;
    let events: ReturnType<typeof regentSystem.run> = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      events = regentSystem.run(state, REGENT_INTERVAL_TICKS);
      took = Math.min(took, performance.now() - started);
    }
    expect(events.length).toBeGreaterThan(52);
    expect(
      took,
      `a visit to all fifty-two nations took ${took.toFixed(2)} ms`,
    ).toBeLessThan(50);
  });
});
