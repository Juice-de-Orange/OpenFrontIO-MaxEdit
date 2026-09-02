import { describe, expect, test } from "vitest";
import {
  ARCHETYPES,
  AXIS_FLOOR,
  DOMINANT,
  focusForArchetype,
  temperamentOf,
} from "../../src/shared/config/temperament";

/**
 * Decision 0028: a ruler's temperament is a function of the seed and the
 * nation, legible (one axis dominant), and never an admiral without a coast.
 */
describe("temperament", () => {
  test("is the same for the same seed and nation, and differs across worlds", () => {
    expect(temperamentOf(42, 7, true)).toEqual(temperamentOf(42, 7, true));
    let differs = 0;
    for (let nation = 1; nation <= 52; nation++) {
      if (
        temperamentOf(42, nation, true).archetype !==
        temperamentOf(43, nation, true).archetype
      ) {
        differs++;
      }
    }
    expect(differs).toBeGreaterThan(20);
  });

  test("every axis stays inside its floor and one, and the dominant one is lifted", () => {
    for (let nation = 1; nation <= 52; nation++) {
      const it = temperamentOf(99, nation, nation % 2 === 0);
      const axes = [
        it.aggression,
        it.caution,
        it.industry,
        it.naval,
        it.air,
        it.science,
      ];
      for (const axis of axes) {
        expect(axis).toBeGreaterThanOrEqual(AXIS_FLOOR);
        expect(axis).toBeLessThanOrEqual(1);
      }
      if (it.archetype === "marshal") {
        expect(it.aggression).toBeGreaterThanOrEqual(0.75);
        expect(it.caution).toBeGreaterThanOrEqual(0.75);
      } else {
        expect(Math.max(...axes)).toBeGreaterThanOrEqual(DOMINANT);
      }
    }
  });

  test("a map of fifty-two rulers is not one ruler in fifty-two colours", () => {
    const seen = new Map<string, number>();
    for (let nation = 1; nation <= 52; nation++) {
      const it = temperamentOf(1234, nation, true);
      seen.set(it.archetype, (seen.get(it.archetype) ?? 0) + 1);
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
    for (const count of seen.values()) expect(count).toBeLessThanOrEqual(21);
    for (const archetype of ARCHETYPES) {
      expect(typeof focusForArchetype(archetype)).toBe("string");
    }
  });

  test("a nation with no coast is never an admiral", () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (let nation = 1; nation <= 52; nation++) {
        const it = temperamentOf(seed, nation, false);
        expect(it.archetype).not.toBe("admiral");
        expect(it.naval).toBe(AXIS_FLOOR);
      }
    }
  });

  test("the focus follows the archetype: conquerors expand, wardens defend", () => {
    expect(focusForArchetype("conqueror")).toBe("expansion");
    expect(focusForArchetype("warden")).toBe("defence");
    expect(focusForArchetype("marshal")).toBe("military");
    expect(focusForArchetype("builder")).toBe("economy");
  });
});
