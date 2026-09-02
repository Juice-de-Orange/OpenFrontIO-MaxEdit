import { describe, expect, test } from "vitest";
import {
  UT_DIVISION,
  UT_FLEET,
  UT_WING,
} from "../../../src/client/render/types/UnitType";
import {
  divisionIconId,
  forcesOf,
  formationIconId,
} from "../../../src/client/world/ForcesAdapter";
import { ProvinceTileIndex } from "../../../src/client/world/ProvinceTileIndex";
import type { ZoneAnchors } from "../../../src/client/world/ZoneAnchors";

/**
 * The forces on the map: a division standing in a province, a wing over the
 * zone it flies in, a fleet over the water it patrols.
 */

/** Four provinces of four tiles each, laid out in a row. */
function index(): ProvinceTileIndex {
  const provinceOfTile = new Int32Array(16);
  for (let tile = 0; tile < 16; tile++)
    provinceOfTile[tile] = Math.floor(tile / 4);
  return new ProvinceTileIndex({ provinceOfTile, provinceCount: 4 });
}

const anchors: ZoneAnchors = {
  air: new Map([[7, 100]]),
  sea: new Map([[3, 200]]),
};

const division = (id: number, provinceId: number, strength = 1) => ({
  id,
  provinceId,
  strength,
});

const formation = (
  id: number,
  template: "wing" | "fleet",
  zone: number | null,
  baseProvinceId = 1,
) => ({ id, template, baseProvinceId, zone, strength: 1 }) as const;

describe("a nation's forces on the map", () => {
  test("a division stands on a tile of its own province, with its number", () => {
    const units = forcesOf(5, [division(3, 2)], [], index(), anchors);
    const unit = units.get(divisionIconId(3));
    expect(unit).toBeDefined();
    expect(unit?.unitType).toBe(UT_DIVISION);
    expect(unit?.ownerID).toBe(5);
    expect(unit?.level).toBe(3);
    // Province 2 owns tiles 8..11 and nothing else.
    expect(unit?.pos).toBeGreaterThanOrEqual(8);
    expect(unit?.pos).toBeLessThanOrEqual(11);
  });

  test("two divisions in one province do not stand on one tile", () => {
    // The spread is a hash, so this is a property of the ids, not luck: over
    // a handful of divisions in a four-tile province some must share, but
    // consecutive ids must not.
    const units = forcesOf(
      1,
      [division(1, 0), division(2, 0), division(3, 0)],
      [],
      index(),
      anchors,
    );
    const places = [1, 2, 3].map((id) => units.get(divisionIconId(id))?.pos);
    expect(new Set(places).size).toBeGreaterThan(1);
  });

  test("a division at sea is not drawn: the crossing has its own marker", () => {
    const units = forcesOf(1, [division(9, -1)], [], index(), anchors);
    expect(units.size).toBe(0);
  });

  test("its strength is the plate's bar, not a number nobody can read", () => {
    const units = forcesOf(1, [division(1, 0, 0.4)], [], index(), anchors);
    expect(units.get(divisionIconId(1))?.health).toBeCloseTo(0.4);
  });

  test("a wing flies over its zone's anchor, a fleet over its own", () => {
    const units = forcesOf(
      2,
      [],
      [formation(1, "wing", 7), formation(2, "fleet", 3)],
      index(),
      anchors,
    );
    expect(units.get(formationIconId(1))).toMatchObject({
      unitType: UT_WING,
      pos: 100,
      level: 1,
    });
    expect(units.get(formationIconId(2))).toMatchObject({
      unitType: UT_FLEET,
      pos: 200,
      level: 2,
    });
  });

  test("a formation standing down waits at its base, where it really is", () => {
    const units = forcesOf(
      2,
      [],
      [formation(4, "wing", null, 3)],
      index(),
      anchors,
    );
    const pos = units.get(formationIconId(4))?.pos ?? -1;
    expect(pos).toBeGreaterThanOrEqual(12);
    expect(pos).toBeLessThanOrEqual(15);
  });

  test("a zone with no anchor falls back to the base rather than vanishing", () => {
    const units = forcesOf(
      2,
      [],
      [formation(6, "fleet", 999, 0)],
      index(),
      anchors,
    );
    const pos = units.get(formationIconId(6))?.pos ?? -1;
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos).toBeLessThanOrEqual(3);
  });

  test("a spectator sees no army: the wire sends it none", () => {
    expect(
      forcesOf(
        null,
        [division(1, 0)],
        [formation(1, "wing", 7)],
        index(),
        anchors,
      ).size,
    ).toBe(0);
  });

  test("force ids never collide with a building's", () => {
    // Buildings are numbered province * BUILDING_TYPES.length + index + 1,
    // which on the largest map stays under ten thousand.
    expect(divisionIconId(1)).toBeGreaterThan(100_000);
    expect(formationIconId(1)).not.toBe(divisionIconId(1));
  });
});
