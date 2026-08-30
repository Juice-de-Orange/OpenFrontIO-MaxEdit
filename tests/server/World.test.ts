import { describe, expect, test } from "vitest";
import { World, type WorldCommand } from "../../src/server/world/World";
import {
  computeProvincePartition,
  type ProvincePartition,
} from "../../src/shared/map/ProvincePartition";
import type {
  MapDescriptor,
  NationStatic,
} from "../../src/shared/protocol/Wire";

const LAND = 0x80;

/** A small continent with three capitals, enough for real borders. */
function fixture(): {
  world: World;
  partition: ProvincePartition;
  descriptor: MapDescriptor;
  nations: NationStatic[];
} {
  // Provinces are cut at roughly 900 tiles each, so a fixture has to be this
  // big before three nations have several provinces apiece — and before any
  // of them has an inland one.
  const width = 180;
  const height = 60;
  const terrain = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) terrain[y * width + x] = LAND | 3;
  }
  const partition = computeProvincePartition(terrain, width, height, [
    { x: 15, y: 30 },
    { x: 165, y: 30 },
    { x: 90, y: 12 },
  ]);
  const nations: NationStatic[] = [
    { smallID: 1, name: "One" },
    { smallID: 2, name: "Two" },
    { smallID: 3, name: "Three" },
  ];
  const descriptor: MapDescriptor = {
    id: "fixture",
    width,
    height,
    provinceCount: partition.count,
    terrainHash: 1,
  };
  return {
    world: World.create(descriptor, nations, partition),
    partition,
    descriptor,
    nations,
  };
}

/** A province owned by `nation` that borders one owned by somebody else. */
function borderProvince(
  world: World,
  partition: ProvincePartition,
  nation: number,
): { mine: number; theirs: number } {
  for (let p = 0; p < partition.count; p++) {
    if (world.ownerOf(p) !== nation) continue;
    for (const n of partition.neighbours[p]) {
      const owner = world.ownerOf(n);
      if (owner !== nation && owner !== 0) return { mine: p, theirs: n };
    }
  }
  throw new Error(`nation ${nation} has no border in this fixture`);
}

/** `count` provinces owned by somebody else that all border `nation`. */
function borderTargets(
  world: World,
  partition: ProvincePartition,
  nation: number,
  count: number,
): number[] {
  const found: number[] = [];
  for (let p = 0; p < partition.count && found.length < count; p++) {
    const owner = world.ownerOf(p);
    if (owner === nation || owner === 0) continue;
    if (partition.neighbours[p].some((n) => world.ownerOf(n) === nation)) {
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
function assertInvariants(world: World, partition: ProvincePartition): void {
  const owners = world.ownerSnapshot();
  expect(owners.length).toBe(partition.count);
  for (const owner of owners) {
    expect(Number.isInteger(owner)).toBe(true);
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThanOrEqual(world.nations.length);
  }
}

describe("World commands", () => {
  test("refuses a claim on a province that does not border the nation", () => {
    const { world, partition } = fixture();
    // A province nation 1 does not touch.
    const distant = (() => {
      for (let p = 0; p < partition.count; p++) {
        if (world.ownerOf(p) === 1) continue;
        if (partition.neighbours[p].every((n) => world.ownerOf(n) !== 1))
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
    const { world, partition } = fixture();
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "claim_province", provinceId: partition.count },
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
    const { world, partition } = fixture();
    const { theirs } = borderProvince(world, partition, 1);
    const command: WorldCommand = {
      nation: 1,
      body: { kind: "claim_province", provinceId: theirs },
    };

    expect(world.rejectionFor(command)).toBeNull();
    const at = world.queueCommand(command);
    expect(at.tick).toBe(world.currentTick() + 1);
    expect(at.seq).toBe(0);

    // Not before its tick.
    expect(world.ownerOf(theirs)).not.toBe(1);
    const changes = world.step();
    expect(world.currentTick()).toBe(at.tick);
    expect(world.ownerOf(theirs)).toBe(1);
    expect(changes).toContainEqual([theirs, 1]);
  });

  test("two commands on one tick keep the order they were accepted in", () => {
    const { world, partition } = fixture();
    const targets = borderTargets(world, partition, 1, 2);
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
    expect(changes.slice(0, 2)).toEqual([
      [targets[0], 1],
      [targets[1], 1],
    ]);
  });

  test("a command is revalidated on the tick it applies, not only when it arrives", () => {
    const { world, partition } = fixture();
    const { theirs } = borderProvince(world, partition, 1);
    const body = { kind: "claim_province", provinceId: theirs } as const;

    // Both are valid when they arrive. By the time the second one applies the
    // first has already made it pointless, and it is skipped -- silently, but
    // identically on every replay, which is the property that matters.
    expect(world.rejectionFor({ nation: 1, body })).toBeNull();
    world.queueCommand({ nation: 1, body });
    expect(world.rejectionFor({ nation: 1, body })).toBeNull();
    world.queueCommand({ nation: 1, body });

    const changes = world.step();
    expect(changes.filter(([p]) => p === theirs)).toEqual([[theirs, 1]]);
  });

  test("the border drift never undoes a command from the same tick", () => {
    const { world, partition } = fixture();
    // Whichever province the drift would take this tick, a command on it wins.
    const probe = World.create(world.descriptor, world.nations, partition);
    const driftChanges = probe.step();
    expect(driftChanges.length).toBeGreaterThan(0);
    const [drifted] = driftChanges[0];

    const owner = world.ownerOf(drifted);
    const claimant = partition.neighbours[drifted]
      .map((n) => world.ownerOf(n))
      .find((n) => n !== owner && n !== 0);
    expect(claimant).toBeDefined();

    world.queueCommand({
      nation: claimant as number,
      body: { kind: "claim_province", provinceId: drifted },
    });
    world.step();
    expect(world.ownerOf(drifted)).toBe(claimant);
  });

  test("a long run keeps every invariant", () => {
    const { world, partition } = fixture();
    for (let i = 0; i < 200; i++) {
      world.step();
      assertInvariants(world, partition);
    }
    expect(world.currentTick()).toBe(200);
  });
});
