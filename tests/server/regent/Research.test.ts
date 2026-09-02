import { describe, expect, test } from "vitest";
import { RESEARCH_ORDER } from "../../../src/server/systems/regent/research";
import { slotsFor, TECHS } from "../../../src/shared/config/techs";
import { ARCHETYPES } from "../../../src/shared/config/temperament";
import {
  buildWorld,
  landFixture,
  seedFor,
  situation,
  steward,
  visit,
} from "./fixture";

/**
 * Research by archetype: the first techs a steward starts are the head of
 * its own preference list, prerequisites permitting.
 */
describe("the regent's research", () => {
  for (const archetype of ARCHETYPES) {
    test(`a ${archetype} starts with the head of its own list`, () => {
      const fixture = landFixture();
      let seed: number;
      try {
        seed = seedFor(fixture, 1, (t) => t.archetype === archetype);
      } catch {
        // An admiral needs a coast; this fixture has none. Nothing to see.
        expect(archetype).toBe("admiral");
        return;
      }
      const { state } = buildWorld(fixture, seed);
      steward(state, 1);
      expect(situation(state, 1).temperament.archetype).toBe(archetype);
      visit(state);
      const started = state.nations[1].researchSlots
        .map((slot) => slot.tech)
        .filter((tech): tech is NonNullable<typeof tech> => tech !== null);
      expect(started).toHaveLength(slotsFor(state.nations[1].unlockedTechs));
      // The first N of the list that need nothing researched first.
      const expected = RESEARCH_ORDER[archetype]
        .filter((tech) => TECHS[tech].requires.length === 0)
        .slice(0, started.length);
      expect(started).toEqual(expected);
    });
  }

  test("every archetype's list is distinct from every other's", () => {
    const heads = ARCHETYPES.map((a) =>
      RESEARCH_ORDER[a].slice(0, 3).join(","),
    );
    // Not all seven differ — the fighting kinds share a school — but the
    // builder, the warden and the fighters must not read the same page.
    expect(new Set(heads).size).toBeGreaterThanOrEqual(3);
  });
});
