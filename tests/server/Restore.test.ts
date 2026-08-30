import { describe, expect, test } from "vitest";
import { MemoryStore } from "../../src/server/db/MemoryStore";
import { World } from "../../src/server/world/World";
import { WorldRunner } from "../../src/server/world/WorldRunner";
import {
  computeProvincePartition,
  type ProvincePartition,
} from "../../src/shared/map/ProvincePartition";
import type {
  MapDescriptor,
  NationStatic,
} from "../../src/shared/protocol/Wire";

const LAND = 0x80;
const WORLD_ID = "world-test";
const SNAPSHOT_EVERY = 60;
const CRASH_AT = 137;

const nations: NationStatic[] = [
  { smallID: 1, name: "One" },
  { smallID: 2, name: "Two" },
  { smallID: 3, name: "Three" },
  { smallID: 4, name: "Four" },
  { smallID: 5, name: "Five" },
];

/**
 * Big enough that the border drift does not eat the world.
 *
 * Provinces are cut at roughly 900 tiles, so this gives 48 of them across five
 * nations. A smaller fixture collapses to one owner inside thirty ticks, and a
 * world with one nation left cannot demonstrate anything about commands.
 */
const descriptor: MapDescriptor = {
  id: "fixture",
  width: 320,
  height: 140,
  provinceCount: 0,
  terrainHash: 0xabcdef,
};

/** The same partition every time: both worlds must derive it identically. */
function partition(): ProvincePartition {
  const { width, height } = descriptor;
  const terrain = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) terrain[y * width + x] = LAND | 3;
  }
  return computeProvincePartition(terrain, width, height, [
    { x: 40, y: 40 },
    { x: 280, y: 40 },
    { x: 40, y: 100 },
    { x: 280, y: 100 },
    { x: 160, y: 70 },
  ]);
}

function newWorld(p: ProvincePartition): World {
  return World.create({ ...descriptor, provinceCount: p.count }, nations, p);
}

/** A province `nation` could legally claim right now, or null. */
function claimable(
  world: World,
  p: ProvincePartition,
  nation: number,
): number | null {
  for (let province = 0; province < p.count; province++) {
    const owner = world.ownerOf(province);
    if (owner === nation || owner === 0) continue;
    if (p.neighbours[province].some((n) => world.ownerOf(n) === nation)) {
      return province;
    }
  }
  return null;
}

/**
 * Run a world forward, issuing claims on the given ticks.
 *
 * Returns the claims that were accepted, so the restored world can be checked
 * against them rather than only against a hash.
 */
async function runTo(
  runner: WorldRunner,
  world: World,
  p: ProvincePartition,
  lastTick: number,
  claimOn: Map<number, number>,
): Promise<{
  accepted: { tick: number; province: number; nation: number }[];
  hashes: Map<number, number>;
  ownersAt: Map<number, number[]>;
}> {
  const accepted: { tick: number; province: number; nation: number }[] = [];
  const hashes = new Map<number, number>();
  const ownersAt = new Map<number, number[]>();
  while (world.currentTick() < lastTick) {
    const nation = claimOn.get(world.currentTick() + 1);
    if (nation !== undefined) {
      const province = claimable(world, p, nation);
      if (province !== null) {
        const result = await runner.submit(nation, {
          kind: "claim_province",
          provinceId: province,
        });
        expect(result.accepted).toBe(true);
        if (result.accepted) {
          accepted.push({ tick: result.tick, province, nation });
        }
      }
    }
    await runner.tickOnce();
    hashes.set(world.currentTick(), world.stateHash());
    ownersAt.set(world.currentTick(), world.ownerSnapshot());
  }
  return { accepted, hashes, ownersAt };
}

describe("restore", () => {
  test("a crashed world comes back identical, with every command intact", async () => {
    const p = partition();
    const store = new MemoryStore();

    // The claims are placed to straddle the last snapshot: 121 and 135 are
    // after the snapshot at 120, so they exist only in the command log.
    const claimOn = new Map<number, number>([
      [7, 1],
      [64, 2],
      [121, 1],
      [135, 2],
    ]);

    const live = newWorld(p);
    const liveRunner = new WorldRunner({
      world: live,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    expect(await liveRunner.restore()).toBe(0);
    const { accepted, hashes, ownersAt } = await runTo(
      liveRunner,
      live,
      p,
      CRASH_AT,
      claimOn,
    );

    expect(live.currentTick()).toBe(CRASH_AT);
    expect(accepted.map((a) => a.tick)).toEqual([7, 64, 121, 135]);

    // The process dies here. Nothing is flushed, nothing is closed.
    const snapshot = await store.latestSnapshot(WORLD_ID);
    expect(snapshot?.tick).toBe(120);

    const restored = newWorld(p);
    const restoredRunner = new WorldRunner({
      world: restored,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    const resumedAt = await restoredRunner.restore();

    // It resumes at 135, not at 137. The durable record ends at the last
    // logged command, and ticks 136 and 137 left no trace: a hard crash costs
    // up to one snapshot interval of *drift* and no player command, which is
    // the trade CLAUDE.md §4 states. Asserting 137 here would be asserting a
    // guarantee the design deliberately does not make.
    expect(resumedAt).toBe(135);
    expect(restored.currentTick()).toBe(135);

    // And at that tick it is the same world, province by province.
    expect(restored.stateHash()).toBe(hashes.get(135));
    expect(restored.ownerSnapshot()).toEqual(ownersAt.get(135));

    // The negative control, which is the actual content of "no lost
    // commands": a world rebuilt from the snapshot alone, replaying the same
    // ticks with the log ignored, lands somewhere else. Without this the two
    // assertions above would still pass if the command log were never read.
    const late = accepted.filter((a) => a.tick > 120);
    expect(late.length).toBe(2);
    const snapshotOnly = newWorld(p);
    snapshotOnly.restoreFrom(
      (snapshot as { state: ReturnType<World["snapshot"]> }).state,
    );
    while (snapshotOnly.currentTick() < 135) snapshotOnly.step();
    expect(snapshotOnly.currentTick()).toBe(135);
    expect(snapshotOnly.ownerSnapshot()).not.toEqual(restored.ownerSnapshot());
  });

  test("the restored world keeps ticking in step with the one it replaced", async () => {
    const p = partition();
    const store = new MemoryStore();

    const live = newWorld(p);
    const liveRunner = new WorldRunner({
      world: live,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    await liveRunner.restore();
    // Stopped exactly on a snapshot, so the restore resumes at the same tick
    // the live world is on and the two can be compared step for step. Away
    // from a boundary they legitimately differ: a hard crash loses up to one
    // snapshot interval of drift, and no commands.
    await runTo(liveRunner, live, p, 120, new Map([[30, 1]]));

    const restored = newWorld(p);
    const restoredRunner = new WorldRunner({
      world: restored,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    expect(await restoredRunner.restore()).toBe(live.currentTick());

    // Both run on from here. A restore that reproduces the state but not the
    // schedule would diverge on the next tick, which is the failure that would
    // otherwise show up days later.
    for (let i = 0; i < 40; i++) {
      await liveRunner.tickOnce();
      await restoredRunner.tickOnce();
      expect(restored.stateHash()).toBe(live.stateHash());
    }
  });

  test("a command is in the log before the world is told about it", async () => {
    const p = partition();
    const store = new MemoryStore();
    const world = newWorld(p);
    const runner = new WorldRunner({ world, store, worldId: WORLD_ID });
    await runner.restore();

    const failing = {
      ...store,
      appendCommand: async () => {
        throw new Error("disk full");
      },
    };
    const brittle = new WorldRunner({
      world,
      store: failing as unknown as MemoryStore,
      worldId: WORLD_ID,
    });
    const province = claimable(world, p, 1);
    expect(province).not.toBeNull();
    await expect(
      brittle.submit(1, {
        kind: "claim_province",
        provinceId: province as number,
      }),
    ).rejects.toThrow("disk full");

    // The world must not be holding a command that no log knows about.
    await brittle.tickOnce();
    expect(world.ownerOf(province as number)).not.toBe(1);
  });

  test("a snapshot that does not match its own hash is refused", async () => {
    const p = partition();
    const store = new MemoryStore();
    const world = newWorld(p);
    await store.ensureWorld(WORLD_ID, descriptor.id, descriptor.terrainHash);
    const state = world.snapshot();
    state.owners[0] = state.owners[0] === 1 ? 2 : 1;
    await store.writeSnapshot(WORLD_ID, {
      tick: state.tick,
      stateHash: world.stateHash(),
      state,
    });

    const runner = new WorldRunner({
      world: newWorld(p),
      store,
      worldId: WORLD_ID,
    });
    await expect(runner.restore()).rejects.toThrow(/damaged/);
  });

  test("a snapshot from another map is refused rather than loaded", async () => {
    const p = partition();
    const store = new MemoryStore();
    const world = newWorld(p);
    const state = world.snapshot();
    expect(() => world.restoreFrom({ ...state, mapId: "elsewhere" })).toThrow(
      /map elsewhere/,
    );
    expect(() => world.restoreFrom({ ...state, terrainHash: 1 })).toThrow(
      /terrain hash/,
    );
    expect(() =>
      world.restoreFrom({ ...state, provinceCount: state.provinceCount + 1 }),
    ).toThrow(/provinces/);
    void store;
  });
});
