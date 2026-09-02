import { beforeEach, describe, expect, test } from "vitest";
import { wantedDivisions } from "../../../src/server/systems/regent/garrison";
import { type WorldState } from "../../../src/server/world/WorldState";
import { DIVISION_MANPOWER } from "../../../src/shared/config/rates";
import { REGENT_STARVING } from "../../../src/shared/config/regent";
import {
  capitalOf,
  division,
  fillArmy,
  hostileNeighbourOf,
  landWorld,
  ofKind,
  situation,
  steward,
  visit,
} from "./fixture";

/**
 * The garrison rule: an army the supply can carry, standing where the
 * threat is.
 */
describe("the regent's garrison", () => {
  let state: WorldState;

  beforeEach(() => {
    ({ state } = landWorld());
    steward(state, 1);
  });

  test("grows to what the supply sources can carry, one division a visit", () => {
    const wanted = wantedDivisions(situation(state, 1));
    expect(wanted).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < wanted + 6; i++) {
      const raised = ofKind(visit(state), "division_raised");
      expect(raised.length).toBeLessThanOrEqual(1);
      fillArmy(state, 1);
    }
    expect(state.nations[1].divisions).toHaveLength(wanted);
    // The men were paid for every one of them.
    expect(state.nations[1].manpower).toBe(
      DIVISION_MANPOWER * 40 - wanted * DIVISION_MANPOWER,
    );
  });

  test("the capital first, then the threatened border", () => {
    const first = ofKind(visit(state), "division_raised");
    expect(first).toHaveLength(1);
    expect(first[0].province).toBe(capitalOf(state, 1));
    fillArmy(state, 1);

    // Somebody masses next door: three enemy divisions in one province that
    // borders mine. The next division goes to face them.
    const s = situation(state, 1);
    const [mineAtBorder, border] = [...s.border.entries()].sort(
      (a, b) => a[0] - b[0],
    )[0];
    const enemyProvince = border.hostile[0];
    const enemy = state.provinceController[enemyProvince];
    for (let i = 0; i < 3; i++) division(state, enemy, enemyProvince);

    const next = ofKind(visit(state), "division_raised");
    expect(next).toHaveLength(1);
    const placed = next[0].province;
    expect(state.map.provinces[placed].neighbours).toContain(enemyProvince);
    void mineAtBorder;
  });

  test("raises nothing new while a division is starving", () => {
    visit(state); // the capital's garrison
    expect(state.nations[1].divisions).toHaveLength(1);
    fillArmy(state, 1);
    // A hollow division somewhere: below the starving line.
    const capital = capitalOf(state, 1);
    division(state, 1, capital, REGENT_STARVING / 2);
    expect(situation(state, 1).starving).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(ofKind(visit(state), "division_raised")).toHaveLength(0);
    }
    // Fed again, the growth resumes.
    const hollow = state.nations[1].divisions[1];
    hollow.equipment = state.nations[1].divisions[0].equipment.slice();
    expect(ofKind(visit(state), "division_raised")).toHaveLength(1);
  });

  test("only ever raises where it both controls and owns (raise_division's rule)", () => {
    // Occupy a neighbour's province: controlled, not owned.
    const theirs = hostileNeighbourOf(state, 1);
    state.provinceController[theirs] = 1;
    for (let i = 0; i < 12; i++) {
      for (const raised of ofKind(visit(state), "division_raised")) {
        expect(state.provinceOwner[raised.province]).toBe(1);
        expect(raised.province).not.toBe(theirs);
      }
      fillArmy(state, 1);
    }
  });
});
