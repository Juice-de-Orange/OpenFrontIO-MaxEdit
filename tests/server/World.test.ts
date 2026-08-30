import { describe, expect, test } from "vitest";
import { World, type WorldCommand } from "../../src/server/world/World";
import { OCCUPATION_TICKS } from "../../src/shared/config/provinces";
import type { ProvinceMap } from "../../src/shared/map/ProvinceMap";
import { mapFixture } from "../util/worldFixture";

/** A small continent with three capitals, enough for real borders. */
function fixture(): { world: World; map: ProvinceMap } {
  const { map, descriptor, nations } = mapFixture({
    width: 180,
    height: 60,
    capitals: [
      { x: 15, y: 30 },
      { x: 165, y: 30 },
      { x: 90, y: 12 },
    ],
  });
  return { world: World.create(descriptor, nations, map), map };
}

/** A province owned by `nation` that borders one owned by somebody else. */
function borderProvince(
  world: World,
  map: ProvinceMap,
  nation: number,
): { mine: number; theirs: number } {
  for (let p = 0; p < map.provinceCount; p++) {
    if (world.ownerOf(p) !== nation) continue;
    for (const n of map.provinces[p].neighbours) {
      const owner = world.ownerOf(n);
      if (owner !== nation && owner !== 0) return { mine: p, theirs: n };
    }
  }
  throw new Error(`nation ${nation} has no border in this fixture`);
}

/** `count` provinces owned by somebody else that all border `nation`. */
function borderTargets(
  world: World,
  map: ProvinceMap,
  nation: number,
  count: number,
): number[] {
  const found: number[] = [];
  for (let p = 0; p < map.provinceCount && found.length < count; p++) {
    const owner = world.ownerOf(p);
    if (owner === nation || owner === 0) continue;
    if (map.provinces[p].neighbours.some((n) => world.ownerOf(n) === nation)) {
      found.push(p);
    }
  }
  if (found.length < count)
    throw new Error("fixture has too few border provinces");
  return found;
}

/**
 * Every invariant a world must satisfy at any tick, per CLAUDE.md §9.
 * Cheap enough to assert after every step in a long run.
 */
function assertInvariants(world: World, map: ProvinceMap): void {
  const owners = world.ownerSnapshot();
  const controllers = world.controllerSnapshot();
  expect(owners.length).toBe(map.provinceCount);
  expect(controllers.length).toBe(map.provinceCount);
  for (const list of [owners, controllers]) {
    for (const nation of list) {
      expect(Number.isInteger(nation)).toBe(true);
      expect(nation).toBeGreaterThanOrEqual(0);
      expect(nation).toBeLessThanOrEqual(world.nations.length);
    }
  }
}

describe("holding and owning", () => {
  test("a claim moves the controller at once and the owner not at all", () => {
    const { world, map } = fixture();
    const { theirs } = borderProvince(world, map, 1);
    const before = world.ownerOf(theirs);

    world.queueCommand({
      nation: 1,
      body: { kind: "claim_province", provinceId: theirs },
    });
    const changes = world.step();

    expect(world.controllerOf(theirs)).toBe(1);
    expect(world.ownerOf(theirs)).toBe(before);
    expect(changes.control).toContainEqual([theirs, 1]);
    expect(changes.owner).toEqual([]);
  });

  /**
   * The occupation period is the whole content of decision 0002: taking
   * ground and holding it are two different costs.
   *
   * Stated as an invariant over a long run rather than as a scripted
   * take-and-wait. The border drift moves a province every tick, so a scripted
   * version spends its time fighting the fixture — it was written that way
   * first, and what it actually measured was which nation happened to be
   * adjacent on tick 300. The invariant holds regardless of who took what.
   */
  test("no province is ever owned before it has been held long enough", () => {
    const { world } = fixture();
    const lastControlChange = new Map<number, number>();
    let transfers = 0;

    for (let i = 0; i < OCCUPATION_TICKS * 2; i++) {
      const changes = world.step();
      const tick = world.currentTick();

      for (const [province, nation] of changes.owner) {
        const heldFrom = lastControlChange.get(province) ?? 0;
        expect(
          tick - heldFrom,
          `province ${province} changed owner ${tick - heldFrom} ticks after ` +
            `its controller last changed`,
        ).toBeGreaterThanOrEqual(OCCUPATION_TICKS);
        expect(world.controllerOf(province)).toBe(nation);
        transfers++;
      }

      // After the owner check, so a province that changed hands this tick is
      // measured from its previous controller.
      for (const [province] of changes.control) {
        lastControlChange.set(province, tick);
      }
    }

    // Without this the whole test passes on a world where nothing was ever
    // occupied long enough, which is the same shape as a green test that
    // checks nothing.
    expect(transfers).toBeGreaterThan(0);
  });

  test("ownership only ever moves to the nation already in control", () => {
    const { world } = fixture();
    for (let i = 0; i < OCCUPATION_TICKS + 50; i++) {
      for (const [province, nation] of world.step().owner) {
        expect(world.controllerOf(province)).toBe(nation);
      }
    }
  });
});

describe("World commands", () => {
  test("refuses a claim on a province that does not border the nation", () => {
    const { world, map } = fixture();
    // A province nation 1 does not touch.
    const distant = (() => {
      for (let p = 0; p < map.provinceCount; p++) {
        if (world.ownerOf(p) === 1) continue;
        if (map.provinces[p].neighbours.every((n) => world.ownerOf(n) !== 1))
          return p;
      }
      throw new Error("no province out of nation 1's reach in the fixture");
    })();

    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "claim_province", provinceId: distant },
      }),
    ).toBe("province does not border your territory");
  });

  test("refuses a claim on a province the nation already holds", () => {
    const { world } = fixture();
    const mine = world.ownerSnapshot().indexOf(1);
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "claim_province", provinceId: mine },
      }),
    ).toBe("province is already yours");
  });

  test("refuses an unknown province and an unknown nation", () => {
    const { world, map } = fixture();
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "claim_province", provinceId: map.provinceCount },
      }),
    ).toMatch(/no province/);
    expect(
      world.rejectionFor({
        nation: 99,
        body: { kind: "claim_province", provinceId: 0 },
      }),
    ).toMatch(/no nation/);
  });

  test("accepts a claim on a bordering province, and applies it on the promised tick", () => {
    const { world, map } = fixture();
    const { theirs } = borderProvince(world, map, 1);
    const command: WorldCommand = {
      nation: 1,
      body: { kind: "claim_province", provinceId: theirs },
    };

    expect(world.rejectionFor(command)).toBeNull();
    const at = world.queueCommand(command);
    expect(at.tick).toBe(world.currentTick() + 1);
    expect(at.seq).toBe(0);

    // Not before its tick.
    expect(world.controllerOf(theirs)).not.toBe(1);
    const changes = world.step();
    expect(world.currentTick()).toBe(at.tick);
    expect(world.controllerOf(theirs)).toBe(1);
    expect(changes.control).toContainEqual([theirs, 1]);
  });

  test("two commands on one tick keep the order they were accepted in", () => {
    const { world, map } = fixture();
    const targets = borderTargets(world, map, 1, 2);
    const first = world.queueCommand({
      nation: 1,
      body: { kind: "claim_province", provinceId: targets[0] },
    });
    const second = world.queueCommand({
      nation: 1,
      body: { kind: "claim_province", provinceId: targets[1] },
    });

    expect(first.tick).toBe(second.tick);
    expect(second.seq).toBe(first.seq + 1);

    const changes = world.step();
    // Order is what `seq` records, and it is the order a replay has to put
    // them back in.
    expect(changes.control.slice(0, 2)).toEqual([
      [targets[0], 1],
      [targets[1], 1],
    ]);
  });

  test("a command is revalidated on the tick it applies, not only when it arrives", () => {
    const { world, map } = fixture();
    const { theirs } = borderProvince(world, map, 1);
    const body = { kind: "claim_province", provinceId: theirs } as const;

    // Both are valid when they arrive. By the time the second one applies the
    // first has already made it pointless, and it is skipped -- silently, but
    // identically on every replay, which is the property that matters.
    expect(world.rejectionFor({ nation: 1, body })).toBeNull();
    world.queueCommand({ nation: 1, body });
    expect(world.rejectionFor({ nation: 1, body })).toBeNull();
    world.queueCommand({ nation: 1, body });

    const changes = world.step();
    expect(changes.control.filter(([p]) => p === theirs)).toEqual([
      [theirs, 1],
    ]);
  });

  test("the border drift never undoes a command from the same tick", () => {
    const { world, map } = fixture();
    // Whichever province the drift would take this tick, a command on it wins.
    const probe = World.create(world.descriptor, world.nations, map);
    const driftChanges = probe.step();
    expect(driftChanges.control.length).toBeGreaterThan(0);
    const [drifted] = driftChanges.control[0];

    const owner = world.ownerOf(drifted);
    const claimant = map.provinces[drifted].neighbours
      .map((n) => world.ownerOf(n))
      .find((n) => n !== owner && n !== 0);
    expect(claimant).toBeDefined();

    world.queueCommand({
      nation: claimant as number,
      body: { kind: "claim_province", provinceId: drifted },
    });
    world.step();
    expect(world.controllerOf(drifted)).toBe(claimant);
  });

  test("a long run keeps every invariant", () => {
    const { world, map } = fixture();
    for (let i = 0; i < 200; i++) {
      world.step();
      assertInvariants(world, map);
    }
    expect(world.currentTick()).toBe(200);
  });
});
