import { describe, expect, test } from "vitest";
import { frontsAllowed } from "../../../src/server/systems/regent/war";
import {
  divisionStrength,
  type WorldState,
} from "../../../src/server/world/WorldState";
import { REGENT_ATTACK_STRENGTH } from "../../../src/shared/config/regent";
import {
  buildWorld,
  fillArmy,
  landFixture,
  ofKind,
  seedFor,
  situation,
  steward,
  visit,
} from "./fixture";

/**
 * The war rule: §6.10's offensive orders under `expansion`, the marshal's
 * one front under `military` (decision 0028), and nothing under the rest.
 */
describe("the regent at war", () => {
  function worldWhere(wish: Parameters<typeof seedFor>[2]): WorldState {
    const fixture = landFixture();
    const seed = seedFor(fixture, 1, wish);
    return buildWorld(fixture, seed).state;
  }

  /** A held target must be attacked from a standing division; empty ground needs none. */
  function stagedFromArmy(state: WorldState, target: number): boolean {
    const holder = state.provinceController[target];
    const held = state.nations[holder].divisions.some(
      (d) => d.province === target && divisionStrength(d) > 0,
    );
    if (!held) return true;
    return state.map.provinces[target].neighbours.some(
      (n) =>
        state.provinceController[n] === 1 &&
        state.nations[1].divisions.some(
          (d) =>
            d.province === n && divisionStrength(d) >= REGENT_ATTACK_STRENGTH,
        ),
    );
  }

  test("expansion opens fronts up to its aggression, each from a standing division", () => {
    const state = worldWhere(() => true);
    steward(state, 1, "expansion");
    const allowed = frontsAllowed(situation(state, 1));
    expect(allowed).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 12; i++) {
      const ordered = ofKind(visit(state), "attack_ordered");
      expect(ordered.length).toBeLessThanOrEqual(1);
      for (const attack of ordered) {
        expect(stagedFromArmy(state, attack.province)).toBe(true);
        // Never at somebody it is at peace with — but this world has no
        // agreements, so the only rule to see is the border itself.
        expect(state.provinceController[attack.province]).not.toBe(1);
      }
      expect(state.nations[1].attacks.length).toBeLessThanOrEqual(allowed);
      fillArmy(state, 1);
    }
    expect(state.nations[1].attacks.length).toBe(allowed);
  });

  test("defence and economy never attack, whatever the temperament", () => {
    const state = worldWhere((t) => t.aggression >= 0.85);
    for (const focus of ["defence", "economy"] as const) {
      steward(state, 1, focus);
      for (let i = 0; i < 8; i++) {
        expect(ofKind(visit(state), "attack_ordered")).toHaveLength(0);
      }
      expect(state.nations[1].attacks).toHaveLength(0);
    }
  });

  test("under military only the marshal attacks, and on one front", () => {
    const marshal = worldWhere((t) => t.archetype === "marshal");
    steward(marshal, 1, "military");
    expect(frontsAllowed(situation(marshal, 1))).toBe(1);
    for (let i = 0; i < 10; i++) {
      visit(marshal);
      fillArmy(marshal, 1);
    }
    expect(marshal.nations[1].attacks).toHaveLength(1);

    const other = worldWhere(
      (t) => t.archetype !== "marshal" && t.aggression >= 0.6,
    );
    steward(other, 1, "military");
    expect(frontsAllowed(situation(other, 1))).toBe(0);
    for (let i = 0; i < 10; i++) {
      expect(ofKind(visit(other), "attack_ordered")).toHaveLength(0);
    }
  });

  test("the garrison stacks the staging so the front has weight behind it", () => {
    const state = worldWhere(() => true);
    steward(state, 1, "expansion");
    for (let i = 0; i < 10; i++) {
      visit(state);
      fillArmy(state, 1);
    }
    const attacks = state.nations[1].attacks;
    expect(attacks.length).toBeGreaterThan(0);
    // Some staging province next to a front holds more than one division.
    const stacked = state.nations[1].divisions.reduce((by, d) => {
      by.set(d.province, (by.get(d.province) ?? 0) + 1);
      return by;
    }, new Map<number, number>());
    const heavy = [...stacked.entries()].filter(([, n]) => n > 1);
    expect(heavy.length).toBeGreaterThan(0);
  });
});
