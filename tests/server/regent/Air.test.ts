import { beforeEach, describe, expect, test } from "vitest";
import { type WorldState } from "../../../src/server/world/WorldState";
import { REGENT_STAND_DOWN } from "../../../src/shared/config/regent";
import { equipmentIndex } from "../../../src/shared/economy/Equipment";
import {
  capitalOf,
  formation,
  landWorld,
  ofKind,
  queued,
  setBuilding,
  situation,
  steward,
  visit,
} from "./fixture";

/**
 * The air rule, as a story: a hostile wing appears over my sky, and the
 * regent answers in the order the game allows — a base, a line, a wing, a
 * mission over exactly that zone.
 */
describe("the regent in the air", () => {
  let state: WorldState;
  let capital: number;
  let sky: number;

  beforeEach(() => {
    ({ state } = landWorld());
    steward(state, 1);
    capital = capitalOf(state, 1);
    sky = state.map.provinces[capital].airZone;
    // Nation 2 flies fighters over my capital's zone from a base of its own.
    const theirs = capitalOf(state, 2);
    setBuilding(state, theirs, "air_base", 1);
    formation(state, 2, theirs, "fighter_wing", sky, "air_superiority");
    expect(situation(state, 1).airThreat.get(sky) ?? 0).toBeGreaterThan(0);
  });

  test("answers a threat in the sky with a base, a line, a wing and a mission", () => {
    // 1. A base, before any focus building.
    const first = queued(visit(state));
    expect(first).toHaveLength(1);
    expect(first[0].building).toBe("air_base");
    expect(state.map.provinces[first[0].provinceId].airZone).toBe(sky);
    expect(state.provinceOwner[first[0].provinceId]).toBe(1);

    // 2. With the base standing — and factories enough for a third line —
    // a fighter line opens.
    setBuilding(state, first[0].provinceId, "air_base", 1);
    setBuilding(state, capital, "military_factory", 3);
    const lines = () =>
      state.nations[1].productionLines.map((line) => line.equipment);
    for (let i = 0; i < 4 && !lines().includes("fighter"); i++) visit(state);
    expect(lines()).toContain("fighter");

    // 3. With fighters in store, a wing is raised at that base.
    state.nations[1].stockpile[equipmentIndex("fighter")] = 100;
    const raised = ofKind(visit(state), "formation_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0].template).toBe("fighter_wing");
    expect(raised[0].base).toBe(first[0].provinceId);

    // 4. Filled, it flies air superiority over exactly the threatened zone.
    const wing = state.nations[1].formations[0];
    wing.equipment[equipmentIndex("fighter")] = 24;
    const sent = ofKind(visit(state), "formation_assigned");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      formationId: wing.id,
      zone: sky,
      mission: "air_superiority",
    });
    // And is left alone once it is where it should be.
    expect(ofKind(visit(state), "formation_assigned")).toHaveLength(0);
  });

  test("brings a worn wing home to refill", () => {
    setBuilding(state, capital, "air_base", 1);
    const worn = formation(
      state,
      1,
      capital,
      "fighter_wing",
      sky,
      "air_superiority",
      REGENT_STAND_DOWN / 2,
    );
    const sent = ofKind(visit(state), "formation_assigned");
    expect(sent).toContainEqual({
      kind: "formation_assigned",
      nation: 1,
      formationId: worn.id,
      zone: null,
      mission: null,
    });
  });

  test("never raises more wings than the stock and the temperament allow", () => {
    setBuilding(state, capital, "air_base", 1);
    state.nations[1].stockpile[equipmentIndex("fighter")] = 10_000;
    const cap = 1 + Math.round(situation(state, 1).temperament.air * 3);
    for (let i = 0; i < cap + 4; i++) visit(state);
    const wings = state.nations[1].formations.filter(
      (f) => f.template === "fighter_wing",
    );
    expect(wings.length).toBeLessThanOrEqual(cap);
    expect(wings.length).toBeGreaterThan(0);
  });
});
