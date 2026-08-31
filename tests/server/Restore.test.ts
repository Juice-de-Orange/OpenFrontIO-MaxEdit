import { describe, expect, test, vi } from "vitest";
import { MemoryStore } from "../../src/server/db/MemoryStore";
import { STATE_HASH_VERSION, World } from "../../src/server/world/World";
import { WorldRunner } from "../../src/server/world/WorldRunner";
import { mapFixture } from "../util/worldFixture";

const WORLD_ID = "world-test";
const SNAPSHOT_EVERY = 60;
const CRASH_AT = 137;

/**
 * Big enough that the border drift does not eat the world.
 *
 * Provinces are cut at roughly 900 tiles, so this gives 48 of them across five
 * nations. A smaller fixture collapses to one owner inside thirty ticks, and a
 * world with one nation left cannot demonstrate anything about commands.
 */
const fixture = mapFixture({
  width: 320,
  height: 140,
  capitals: [
    { x: 40, y: 40 },
    { x: 280, y: 40 },
    { x: 40, y: 100 },
    { x: 280, y: 100 },
    { x: 160, y: 70 },
  ],
});

function newWorld(): World {
  return World.create(fixture.descriptor, fixture.nations, fixture.map);
}

/** A province `nation` could legally claim right now, or null. */
function claimable(world: World, nation: number): number | null {
  for (let province = 0; province < fixture.map.provinceCount; province++) {
    const holder = world.controllerOf(province);
    if (holder === nation || holder === 0) continue;
    if (
      fixture.map.provinces[province].neighbours.some(
        (n) => world.controllerOf(n) === nation,
      )
    ) {
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
  lastTick: number,
  claimOn: Map<number, number>,
): Promise<{
  accepted: { tick: number; province: number; nation: number }[];
  hashes: Map<number, number>;
  /** Who *held* each province at that tick, which is what a claim moves. */
  ownersAt: Map<number, number[]>;
}> {
  const accepted: { tick: number; province: number; nation: number }[] = [];
  const hashes = new Map<number, number>();
  const ownersAt = new Map<number, number[]>();
  while (world.currentTick() < lastTick) {
    const nation = claimOn.get(world.currentTick() + 1);
    if (nation !== undefined) {
      const province = claimable(world, nation);
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
    ownersAt.set(world.currentTick(), world.controllerSnapshot());
  }
  return { accepted, hashes, ownersAt };
}

describe("restore", () => {
  test("a crashed world comes back identical, with every command intact", async () => {
    const store = new MemoryStore();

    // The claims are placed to straddle the last snapshot: 121 and 135 are
    // after the snapshot at 120, so they exist only in the command log.
    const claimOn = new Map<number, number>([
      [7, 1],
      [64, 2],
      [121, 1],
      [135, 2],
    ]);

    const live = newWorld();
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
      CRASH_AT,
      claimOn,
    );

    expect(live.currentTick()).toBe(CRASH_AT);
    expect(accepted.map((a) => a.tick)).toEqual([7, 64, 121, 135]);

    // The process dies here. Nothing is flushed, nothing is closed.
    const snapshot = await store.latestSnapshot(WORLD_ID);
    expect(snapshot?.tick).toBe(120);

    const restored = newWorld();
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
    expect(restored.controllerSnapshot()).toEqual(ownersAt.get(135));

    // The negative control, which is the actual content of "no lost
    // commands": a world rebuilt from the snapshot alone, replaying the same
    // ticks with the log ignored, lands somewhere else. Without this the two
    // assertions above would still pass if the command log were never read.
    const late = accepted.filter((a) => a.tick > 120);
    expect(late.length).toBe(2);
    const snapshotOnly = newWorld();
    snapshotOnly.restoreFrom(
      (snapshot as { state: ReturnType<World["snapshot"]> }).state,
    );
    while (snapshotOnly.currentTick() < 135) snapshotOnly.step();
    expect(snapshotOnly.currentTick()).toBe(135);
    // Control, not ownership. A claim moves the controller at once and the
    // owner only after OCCUPATION_TICKS, which is longer than this whole run
    // — so comparing owners here compares two arrays that the commands were
    // never going to change, and the control asserts nothing.
    expect(snapshotOnly.controllerSnapshot()).not.toEqual(
      restored.controllerSnapshot(),
    );
  });

  test("an agreement made after the last snapshot comes back from the log", async () => {
    const store = new MemoryStore();
    const live = newWorld();
    const runner = new WorldRunner({
      world: live,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    await runner.restore();

    // Past the snapshot at 60, so what follows exists only in the command log.
    while (live.currentTick() < 70) await runner.tickOnce();

    const offered = await runner.submit(1, {
      kind: "propose_agreement",
      to: 2,
      type: "trade",
      terms: { resource: "steel", resourcePerTick: 0.5, pointsPerTick: 0.25 },
    });
    expect(offered.accepted).toBe(true);
    await runner.tickOnce();
    const id = live.view().agreements[0].id;
    const accepted = await runner.submit(2, {
      kind: "accept_agreement",
      agreementId: id,
    });
    expect(accepted.accepted).toBe(true);
    await runner.tickOnce();

    expect(live.view().agreements[0].accepted).toBe(true);
    // Measured at the tick the last command landed on, because that is where
    // a restore comes back to: the durable record ends at the last logged
    // command and the ticks after it left no trace. The test above says the
    // same thing about a claim.
    const hash = live.stateHash();
    const tick = live.currentTick();
    await runner.tickOnce();
    await runner.tickOnce();

    // The process dies here, with no snapshot since tick 60.
    expect((await store.latestSnapshot(WORLD_ID))?.tick).toBe(60);

    const restored = newWorld();
    const restoredRunner = new WorldRunner({
      world: restored,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    await restoredRunner.restore();

    // §4 asks for diplomatic state to be in the snapshot *and* derivable from
    // the command log alone. This is the second half: the snapshot predates
    // the agreement entirely, so everything about it — the id, the terms, and
    // the fact that the other side said yes — was rebuilt from four commands.
    expect(restored.currentTick()).toBe(tick);
    const agreement = restored.view().agreements[0];
    expect(agreement?.id).toBe(id);
    expect(agreement?.accepted).toBe(true);
    expect(agreement?.terms?.resourcePerTick).toBe(0.5);
    expect(restored.stateHash()).toBe(hash);
  });

  test("order ids keep counting after a restore instead of starting again", async () => {
    const store = new MemoryStore();
    const live = newWorld();
    const runner = new WorldRunner({
      world: live,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    await runner.restore();

    const home = fixture.map.provinces.find(
      (province) => province.capital && live.controllerOf(province.id) === 1,
    );
    expect(home).toBeDefined();
    const queue = async () => {
      const result = await runner.submit(1, {
        kind: "queue_construction",
        provinceId: home?.id ?? 0,
        building: "civilian_factory",
      });
      expect(result.accepted).toBe(true);
      await runner.tickOnce();
    };

    await queue();
    while (live.currentTick() < SNAPSHOT_EVERY) await runner.tickOnce();
    const ids = live.view().nations[1].constructionQueue.map((o) => o.id);
    expect(ids).toEqual([1]);

    const restored = newWorld();
    const restoredRunner = new WorldRunner({
      world: restored,
      store,
      worldId: WORLD_ID,
      snapshotEvery: SNAPSHOT_EVERY,
    });
    await restoredRunner.restore();
    await restoredRunner.submit(1, {
      kind: "queue_construction",
      provinceId: home?.id ?? 0,
      building: "military_factory",
    });
    await restoredRunner.tickOnce();

    // Two orders, two different ids. The counter used to be left out of the
    // snapshot entirely, so a restored world handed out id 1 a second time —
    // and `cancel_construction`, which names an order by id, then cancelled
    // whichever of them `findIndex` reached first.
    const after = restored.view().nations[1].constructionQueue.map((o) => o.id);
    expect(after).toHaveLength(2);
    expect(new Set(after).size).toBe(2);
  });

  test("the restored world keeps ticking in step with the one it replaced", async () => {
    const store = new MemoryStore();

    const live = newWorld();
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
    await runTo(liveRunner, live, 120, new Map([[30, 1]]));

    const restored = newWorld();
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
    const store = new MemoryStore();
    const world = newWorld();
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
    const province = claimable(world, 1);
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
    const store = new MemoryStore();
    const world = newWorld();
    await store.ensureWorld(
      WORLD_ID,
      fixture.descriptor.id,
      fixture.descriptor.terrainHash,
      fixture.descriptor.partitionHash,
    );
    const state = world.snapshot();
    state.owners[0] = state.owners[0] === 1 ? 2 : 1;
    await store.writeSnapshot(WORLD_ID, {
      tick: state.tick,
      stateHash: world.stateHash(),
      state,
    });

    const runner = new WorldRunner({
      world: newWorld(),
      store,
      worldId: WORLD_ID,
    });
    await expect(runner.restore()).rejects.toThrow(/damaged/);
  });

  test("a snapshot with no hash version is checked as version 1", async () => {
    // Before versioning existed the field was absent, and the function did
    // not change between then and version 1 being written down — so the
    // corruption check must still hold across that boundary, not lapse.
    const store = new MemoryStore();
    const world = newWorld();
    await store.ensureWorld(
      WORLD_ID,
      fixture.descriptor.id,
      fixture.descriptor.terrainHash,
      fixture.descriptor.partitionHash,
    );
    const state = world.snapshot();
    delete state.hashVersion;
    state.owners[0] = state.owners[0] === 1 ? 2 : 1;
    await store.writeSnapshot(WORLD_ID, {
      tick: state.tick,
      stateHash: world.stateHash(),
      state,
    });

    const runner = new WorldRunner({
      world: newWorld(),
      store,
      worldId: WORLD_ID,
    });
    if (STATE_HASH_VERSION === 1) {
      await expect(runner.restore()).rejects.toThrow(/damaged/);
    } else {
      // Once the version has moved past 1, an unversioned snapshot really is
      // from another hash function and must load under the skip rule instead.
      await expect(runner.restore()).resolves.toBe(state.tick);
    }
  });

  test("a snapshot from another hash version loads, loudly", async () => {
    // The check cannot tell corruption from its own history once the function
    // has changed, and refusing here is what used to end a season on every
    // deploy that touched the state (docs/decisions/0016). Accept, and say so.
    const store = new MemoryStore();
    const world = newWorld();
    await store.ensureWorld(
      WORLD_ID,
      fixture.descriptor.id,
      fixture.descriptor.terrainHash,
      fixture.descriptor.partitionHash,
    );
    const state = world.snapshot();
    state.hashVersion = STATE_HASH_VERSION + 1;
    await store.writeSnapshot(WORLD_ID, {
      tick: state.tick,
      // Deliberately not what any build computes: across versions the number
      // is meaningless, and the restore must not compare it at all.
      stateHash: 0xdeadbeef,
      state,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runner = new WorldRunner({
        world: newWorld(),
        store,
        worldId: WORLD_ID,
      });
      await expect(runner.restore()).resolves.toBe(state.tick);
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toMatch(/state-hash check skipped/);
      expect(said).toContain(`version ${STATE_HASH_VERSION + 1}`);
    } finally {
      warn.mockRestore();
    }
  });

  test("a snapshot from another map is refused rather than loaded", async () => {
    const store = new MemoryStore();
    const world = newWorld();
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
