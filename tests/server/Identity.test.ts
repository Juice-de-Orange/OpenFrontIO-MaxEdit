import { describe, expect, test } from "vitest";
import { MemoryStore } from "../../src/server/db/MemoryStore";
import { hashToken, IdentityService } from "../../src/server/net/Identity";
import { openSeason, regentFocusFor } from "../../src/server/world/Season";
import { World } from "../../src/server/world/World";
import { WorldRunner } from "../../src/server/world/WorldRunner";
import { mapFixture } from "../util/worldFixture";

/**
 * Phase 11's rules, tested where they can be tested without a socket.
 *
 * The wire half — an impostor's hello refused before anything is sent, a
 * newer connection superseding an older one — is the phase-11 gate's job
 * over a real WebSocket; this file holds the rules the socket consults.
 */
const WORLD_ID = "world-test";

function service(): { identity: IdentityService; store: MemoryStore } {
  const store = new MemoryStore();
  return { identity: new IdentityService(store, WORLD_ID), store };
}

describe("identity", () => {
  test("who plays which nation is known by name, for the wire's ruler (decision 0024)", async () => {
    const { identity } = service();
    const max = (await identity.register("Max")).account;
    const nobody = (await identity.register("Anonymous")).account;
    expect(await identity.claim(4, max.id)).toBe("ok");
    expect(await identity.claim(9, nobody.id)).toBe("ok");
    const holders = await identity.holderNames();
    expect(holders.get(4)).toBe("Max");
    // The placeholder is stored like any name; the wire decides it is nobody.
    expect(holders.get(9)).toBe("Anonymous");
    expect(holders.has(1)).toBe(false);
  });

  test("a token authenticates its own account, and only a hash is stored", async () => {
    const { identity, store } = service();
    const { account, token } = await identity.register("Max");
    expect(token).toHaveLength(64);

    const found = await identity.authenticate(token);
    expect(found).toEqual({ id: account.id, name: "Max" });
    expect(await identity.authenticate("not-a-token")).toBeNull();

    // The store never saw the token itself — a database dump must leak no
    // credential anybody could log in with.
    expect(await store.accountByTokenHash(token)).toBeNull();
    expect(await store.accountByTokenHash(hashToken(token))).not.toBeNull();
  });

  /**
   * What a chooser needs, and what it must not have.
   *
   * The nation used to come from `?nation=` in the URL and nowhere else, so
   * arriving at the world without a number meant watching for ever. A chooser
   * needs to know which nations are dead ends — and nothing more than that:
   * *who* holds one is an account, and accounts are nobody else's business.
   */
  test("the claimed nations are listable, and say nothing about who", async () => {
    const { identity } = service();
    expect(await identity.claimedNations()).toEqual([]);

    const alice = (await identity.register("Alice")).account;
    const bob = (await identity.register("Bob")).account;
    expect(await identity.claim(7, alice.id)).toBe("ok");
    expect(await identity.claim(3, bob.id)).toBe("ok");

    const claimed = await identity.claimedNations();
    expect([...claimed].sort((a, b) => a - b)).toEqual([3, 7]);
    // Numbers, not accounts. A list that leaked the holder would make the
    // chooser a directory of who is playing what.
    expect(claimed.every((id) => typeof id === "number")).toBe(true);
  });

  test("a claim in another world does not show up in this one", async () => {
    const store = new MemoryStore();
    const here = new IdentityService(store, WORLD_ID);
    const elsewhere = new IdentityService(store, "some-other-world");
    const account = (await here.register("Max")).account;

    expect(await elsewhere.claim(9, account.id)).toBe("ok");
    expect(await here.claimedNations()).toEqual([]);
    expect(await elsewhere.claimedNations()).toEqual([9]);
  });

  test("one nation per account, one account per nation, idempotently", async () => {
    const { identity } = service();
    const alice = (await identity.register("Alice")).account;
    const bob = (await identity.register("Bob")).account;

    expect(await identity.claim(7, alice.id)).toBe("ok");
    // The same claim again is a reconnect, not a conflict.
    expect(await identity.claim(7, alice.id)).toBe("ok");
    // Another account at the same nation: the gate's first sentence.
    expect(await identity.claim(7, bob.id)).toBe("taken");
    // The same account at another nation: §10's one-nation rule.
    expect(await identity.claim(8, alice.id)).toBe("elsewhere");
    // A free nation for the other account works.
    expect(await identity.claim(8, bob.id)).toBe("ok");
  });

  test("opening the season hands every unclaimed nation to its regent", async () => {
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
    const world = World.create(
      fixture.descriptor,
      fixture.nations,
      fixture.map,
      3,
    );
    const store = new MemoryStore();
    await store.ensureWorld(
      WORLD_ID,
      fixture.descriptor.id,
      fixture.descriptor.terrainHash,
      fixture.descriptor.partitionHash,
    );
    const runner = new WorldRunner({ world, store, worldId: WORLD_ID });

    const identity = new IdentityService(store, WORLD_ID);
    const player = (await identity.register("Max")).account;
    expect(await identity.claim(2, player.id)).toBe("ok");

    const opened = await openSeason(world, runner, store, WORLD_ID);
    expect(opened).toBe(fixture.nations.length - 1);
    await runner.tickOnce();

    const state = world.view();
    for (let nation = 1; nation <= fixture.nations.length; nation++) {
      // The claimed nation keeps decision 0018's default; every other one is
      // played from here on (§6.10's promise, kept by decision 0019).
      expect(state.nations[nation].regent.enabled).toBe(nation !== 2);
      // Each with a focus of its own, drawn from the seed and reproducible —
      // it went through the log as a command, so a replay re-rolls nothing.
      if (nation !== 2) {
        expect(state.nations[nation].regent.focus).toBe(
          regentFocusFor(state.worldSeed, nation),
        );
      }
    }
    // Over a full map the draw uses every focus, so the world is not fifty
    // identical stewards.
    const foci = new Set<string>();
    for (let nation = 1; nation <= 52; nation++) {
      foci.add(regentFocusFor(state.worldSeed, nation));
    }
    expect(foci.size).toBe(4);

    // Idempotent: a restart opens nothing a second time, so the command log
    // does not grow by a nation count every boot.
    expect(await openSeason(world, runner, store, WORLD_ID)).toBe(0);
  });
});
