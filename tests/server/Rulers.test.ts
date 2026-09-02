import { describe, expect, test } from "vitest";
import { World } from "../../src/server/world/World";
import { rulerName } from "../../src/shared/config/rulers";
import { mapFixture } from "../util/worldFixture";

/**
 * Decision 0023: a ruler is a function of the world seed and the nation, so
 * every start of a world names the same people and no snapshot has to carry
 * them — a name that moved the state hash would end the running season.
 */
function fixture() {
  return mapFixture({
    width: 160,
    height: 100,
    capitals: [
      { x: 30, y: 30 },
      { x: 130, y: 30 },
      { x: 80, y: 70 },
    ],
  });
}

describe("rulers", () => {
  test("the same seed and nation always name the same person", () => {
    expect(rulerName(1234, 7)).toBe(rulerName(1234, 7));
    expect(rulerName(1234, 7)).toMatch(/^\S+ \S+$/);
  });

  test("neighbouring nations do not share a ruler, and other worlds differ", () => {
    const names = new Set<string>();
    for (let nation = 1; nation <= 52; nation++)
      names.add(rulerName(99, nation));
    expect(names.size).toBeGreaterThan(48); // a collision or two is allowed
    let differs = 0;
    for (let nation = 1; nation <= 52; nation++) {
      if (rulerName(99, nation) !== rulerName(100, nation)) differs++;
    }
    expect(differs).toBeGreaterThan(45);
  });

  test("a world fills in its nations' rulers from its own seed", () => {
    const f = fixture();
    const a = World.create(f.descriptor, f.nations, f.map, 4321);
    const b = World.create(f.descriptor, f.nations, f.map, 4321);
    expect(a.nations.map((n) => n.ruler)).toEqual(
      b.nations.map((n) => n.ruler),
    );
    expect(a.nations[0].ruler).toBe(rulerName(4321, 1));
    // The seed the fixture gave is untouched: the world adds, it does not rewrite.
    expect(a.nations[0].name).toBe(f.nations[0].name);
  });

  test("a ruler handed in is kept", () => {
    const f = fixture();
    const nations = f.nations.map((n, i) =>
      i === 0 ? { ...n, ruler: "Handed In" } : n,
    );
    const world = World.create(f.descriptor, nations, f.map, 1);
    expect(world.nations[0].ruler).toBe("Handed In");
    expect(world.nations[1].ruler).toBe(rulerName(1, 2));
  });
});
