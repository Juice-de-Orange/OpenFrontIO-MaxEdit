import { describe, expect, test } from "vitest";
import { World } from "../../src/server/world/World";
import { mapFixture } from "../util/worldFixture";

/**
 * Two things that were both wrong before construction orders had ids, and that
 * a player would hit within a minute of using the build menu.
 */
function build(): { world: World; nation: number; capital: number } {
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
  const capital = fixture.map.provinces.find((p) => p.capital);
  expect(capital).toBeDefined();
  const found = capital as { id: number; nation: number };
  return {
    world: World.create(fixture.descriptor, fixture.nations, fixture.map),
    nation: found.nation,
    capital: found.id,
  };
}

function queueCommand(
  nation: number,
  province: number,
  building: "supply_hub" | "air_base" | "military_factory",
) {
  return {
    nation,
    body: {
      kind: "queue_construction" as const,
      provinceId: province,
      building,
    },
  };
}

describe("commands accepted in the same tick", () => {
  /**
   * Every build order used to be validated against the queue as it stood
   * *before* any of them were applied, so three sent in the same five seconds
   * were all acked "accepted for tick N" and the surplus was silently skipped
   * when the tick ran. CLAUDE.md §7: a command that is quietly dropped is the
   * failure the whole ack protocol exists to prevent.
   *
   * The fixture capital has six slots and starts with four buildings, so the
   * third of these is one too many — which is the point. All three take a slot
   * and none is coastal-only: an earlier version used `naval_base`, which the
   * inland capital refused for its own reasons, so only two were ever accepted
   * and the test passed with the fix switched off. Verified by switching it
   * off: without the fix this reports three accepted against a queue of two.
   */
  test("are validated against each other, not only against the queue", () => {
    const { world, nation, capital } = build();

    let accepted = 0;
    for (const building of [
      "supply_hub",
      "air_base",
      "military_factory",
    ] as const) {
      const command = queueCommand(nation, capital, building);
      if (world.rejectionFor(command) !== null) continue;
      world.queueCommand(command);
      accepted++;
    }
    world.step();

    // More than one accepted, or there is nothing to interact and the
    // assertion below is vacuous.
    expect(accepted).toBeGreaterThan(1);
    // And everything accepted has to be there. Nothing may be acked and then
    // dropped.
    expect(world.constructionQueueOf(nation)).toHaveLength(accepted);
  });
});

describe("cancelling by order id", () => {
  test("two cancellations in one tick remove the two that were named", () => {
    const { world, nation, capital } = build();
    for (const building of ["supply_hub", "air_base"] as const) {
      const command = queueCommand(nation, capital, building);
      if (world.rejectionFor(command) === null) world.queueCommand(command);
    }
    world.step();

    const queue = world.constructionQueueOf(nation);
    expect(queue.length).toBe(2);
    const [first, second] = [queue[0].id, queue[1].id];

    world.queueCommand({
      nation,
      body: { kind: "cancel_construction", orderId: first },
    });
    world.queueCommand({
      nation,
      body: { kind: "cancel_construction", orderId: second },
    });
    world.step();

    // By position, the second cancellation would have removed whatever slid
    // into slot 1 — or been refused as out of range, leaving an "accepted"
    // ack and an order still sitting there.
    expect(world.constructionQueueOf(nation)).toHaveLength(0);
  });

  test("ids are never reused, so a cancelled order cannot be hit twice", () => {
    const { world, nation, capital } = build();
    const queue = () => world.constructionQueueOf(nation);

    world.queueCommand(queueCommand(nation, capital, "supply_hub"));
    world.step();
    const first = queue()[0].id;

    world.queueCommand({
      nation,
      body: { kind: "cancel_construction", orderId: first },
    });
    world.step();
    expect(queue()).toHaveLength(0);

    world.queueCommand(queueCommand(nation, capital, "air_base"));
    world.step();
    expect(queue()[0].id).toBeGreaterThan(first);

    // And the old id is refused rather than hitting the new order.
    expect(
      world.rejectionFor({
        nation,
        body: { kind: "cancel_construction", orderId: first },
      }),
    ).toMatch(/no construction order/);
  });
});
