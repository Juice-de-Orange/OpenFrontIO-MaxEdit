/**
 * The Postgres store, against a real Postgres.
 *
 * Skipped unless TEST_DATABASE_URL is set, because a unit suite that needs a
 * container is a unit suite people stop running. Start one with:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgres://openfront:openfront@localhost:5432/openfront \
 *     npx vitest run tests/server/PgStore.test.ts
 *
 * What is tested here is only what cannot be tested without a database: the
 * advisory lock, the round trip through gzip and bytea, and the ordering the
 * replay depends on. The replay logic itself is covered by Restore.test.ts
 * against the memory store — and once more here, end to end, because a store
 * that satisfies the interface in isolation and not in use is the failure this
 * seam invites.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PgStore } from "../../src/server/db/PgStore";
import { World } from "../../src/server/world/World";
import { WorldRunner } from "../../src/server/world/WorldRunner";
import { FRONT_MARCH_ADVANCE } from "../../src/shared/config/combat";
import { mapFixture } from "../util/worldFixture";

const URL = process.env.TEST_DATABASE_URL;

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

let unique = 0;
function worldId(): string {
  return `test-${process.pid}-${Date.now()}-${unique++}`;
}

describe.skipIf(URL === undefined || URL === "")("PgStore", () => {
  let store: PgStore;

  beforeAll(async () => {
    store = await PgStore.connect({ connectionString: URL as string });
  });

  afterAll(async () => {
    await store?.close();
  });

  test("records a world's identity and refuses a different map for it", async () => {
    const id = worldId();
    await store.ensureWorld(id, "europe", 0x1234, 0xabcd);
    // Idempotent: every start calls this.
    await store.ensureWorld(id, "europe", 0x1234, 0xabcd);
    await expect(store.ensureWorld(id, "asia", 0x1234, 0xabcd)).rejects.toThrow(
      /created on map europe/,
    );
    await expect(
      store.ensureWorld(id, "europe", 0x9999, 0xabcd),
    ).rejects.toThrow(/terrain/);
  });

  /**
   * The one the terrain hash cannot catch. A regenerated artefact over
   * unchanged terrain — a fix to the partition, or a tuned number in
   * shared/config/provinces.ts — passes every other check and then means
   * something different by every province id in the command log.
   */
  test("refuses a different province artefact over the same terrain", async () => {
    const id = worldId();
    await store.ensureWorld(id, "europe", 0x1234, 0xabcd);
    await expect(
      store.ensureWorld(id, "europe", 0x1234, 0xbeef),
    ).rejects.toThrow(/province artefact/);
  });

  test("returns commands in (tick, seq) order, whatever order they arrived in", async () => {
    const id = worldId();
    await store.ensureWorld(id, "europe", 1, 1);
    const written = [
      {
        tick: 9,
        seq: 1,
        nation: 2,
        body: { kind: "claim_province" as const, provinceId: 5 },
      },
      {
        tick: 4,
        seq: 0,
        nation: 1,
        body: { kind: "claim_province" as const, provinceId: 1 },
      },
      {
        tick: 9,
        seq: 0,
        nation: 3,
        body: { kind: "claim_province" as const, provinceId: 4 },
      },
    ];
    for (const command of written) await store.appendCommand(id, command);

    expect(await store.commandsAfter(id, 0)).toEqual([
      written[1],
      written[2],
      written[0],
    ]);
    expect(await store.commandsAfter(id, 4)).toEqual([written[2], written[0]]);
    expect(await store.commandsAfter(id, 9)).toEqual([]);
  });

  test("refuses to log two commands in the same slot", async () => {
    const id = worldId();
    await store.ensureWorld(id, "europe", 1, 1);
    const command = {
      tick: 3,
      seq: 0,
      nation: 1,
      body: { kind: "claim_province" as const, provinceId: 0 },
    };
    await store.appendCommand(id, command);
    await expect(store.appendCommand(id, command)).rejects.toThrow();
  });

  test("a snapshot survives the round trip through gzip and bytea", async () => {
    const id = worldId();
    await store.ensureWorld(
      id,
      fixture.descriptor.id,
      fixture.descriptor.terrainHash,
      fixture.descriptor.partitionHash,
    );
    const world = newWorld();
    world.step();
    world.step();
    const state = world.snapshot();
    await store.writeSnapshot(id, {
      tick: state.tick,
      stateHash: world.stateHash(),
      state,
    });

    const back = await store.latestSnapshot(id);
    expect(back?.tick).toBe(state.tick);
    expect(back?.stateHash).toBe(world.stateHash());
    expect(back?.state).toEqual(state);
  });

  test("latestSnapshot returns the newest, not the last written", async () => {
    const id = worldId();
    await store.ensureWorld(
      id,
      fixture.descriptor.id,
      fixture.descriptor.terrainHash,
      fixture.descriptor.partitionHash,
    );
    const world = newWorld();
    const first = world.snapshot();
    while (world.currentTick() < 10) world.step();
    const later = world.snapshot();

    await store.writeSnapshot(id, {
      tick: later.tick,
      stateHash: 2,
      state: later,
    });
    await store.writeSnapshot(id, {
      tick: first.tick,
      stateHash: 1,
      state: first,
    });

    expect((await store.latestSnapshot(id))?.tick).toBe(later.tick);
  });

  test("a second process cannot take a world that is already locked", async () => {
    const id = worldId();
    const first = await PgStore.connect({ connectionString: URL as string });
    const second = await PgStore.connect({ connectionString: URL as string });
    try {
      expect(await first.acquireWorldLock(id)).toBe(true);
      expect(await second.acquireWorldLock(id)).toBe(false);
      // And a different world is unaffected.
      expect(await second.acquireWorldLock(worldId())).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }

    // Once the holder is gone the lock is free again, which is what makes a
    // restart possible at all.
    const third = await PgStore.connect({ connectionString: URL as string });
    try {
      expect(await third.acquireWorldLock(id)).toBe(true);
    } finally {
      await third.close();
    }
  });

  test("a crashed world comes back from Postgres with its commands intact", async () => {
    const id = worldId();
    const live = newWorld();
    const runner = new WorldRunner({
      world: live,
      store,
      worldId: id,
      snapshotEvery: 20,
    });
    await runner.restore();

    const claimed: { tick: number; province: number }[] = [];
    const claimOn = new Set([24, 40]);
    while (live.currentTick() < 47) {
      if (claimOn.has(live.currentTick())) {
        let target = -1;
        for (
          let province = 0;
          province < fixture.map.provinceCount && target < 0;
          province++
        ) {
          const holder = live.controllerOf(province);
          if (holder === 1 || holder === 0) continue;
          if (
            fixture.map.provinces[province].neighbours.some(
              (n) => live.controllerOf(n) === 1,
            )
          ) {
            target = province;
          }
        }
        expect(target).toBeGreaterThanOrEqual(0);
        const result = await runner.submit(1, {
          kind: "claim_province",
          provinceId: target,
        });
        expect(result.accepted).toBe(true);
        if (result.accepted)
          claimed.push({ tick: result.tick, province: target });
      }
      await runner.tickOnce();
    }

    // The last snapshot is at 40 and the last command takes effect at 41, so
    // the world resumes at 41 rather than 47: a hard crash costs drift, never
    // a command (decision 0005).
    expect(claimed.map((c) => c.tick)).toEqual([25, 41]);
    const ownersAt41 = new Map<number, number>();
    for (const claim of claimed) {
      ownersAt41.set(claim.province, 1);
    }

    const restored = newWorld();
    const restoredRunner = new WorldRunner({
      world: restored,
      store,
      worldId: id,
      snapshotEvery: 20,
    });
    expect(await restoredRunner.restore()).toBe(41);
    expect(restored.currentTick()).toBe(41);

    // The command logged at 41 is after the last snapshot, so it exists only
    // in the log. If the log were not read, this order would not be standing.
    //
    // The *order*, not yet the province: a claim starts a march that takes
    // `1 / FRONT_MARCH_ADVANCE` ticks (invariant 1), so at tick 41 the front
    // has taken one step and the controller has not moved. Stepping the world
    // past the march is what turns the replayed command into ground. This
    // test is skipped without TEST_DATABASE_URL, which is why it was still
    // asserting the phase-1 shape after phase 2 split owner from controller:
    // `npm run test` does not run it. `npm run test:db` does.
    expect(
      restored
        .view()
        .nations[1].attacks.some((a) => a.province === claimed[1].province),
    ).toBe(true);
    const marchTicks = Math.round(1 / FRONT_MARCH_ADVANCE);
    for (let i = 0; i < marchTicks; i++) restored.step();
    expect(restored.controllerOf(claimed[1].province)).toBe(1);

    // And the same world reached without the log lands somewhere else.
    const snapshot = await store.latestSnapshot(id);
    expect(snapshot?.tick).toBe(40);
    const snapshotOnly = newWorld();
    snapshotOnly.restoreFrom((snapshot as NonNullable<typeof snapshot>).state);
    while (snapshotOnly.currentTick() < restored.currentTick()) {
      snapshotOnly.step();
    }
    expect(snapshotOnly.controllerSnapshot()).not.toEqual(
      restored.controllerSnapshot(),
    );
  });
});
