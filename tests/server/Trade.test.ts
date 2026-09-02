import { beforeEach, describe, expect, test } from "vitest";
import { measureNation } from "../../src/server/systems/economy";
import {
  constructionAvailable,
  isDeadPartner,
  nationTrade,
  tradeSystem,
  trustRegrowth,
} from "../../src/server/systems/trade";
import { World } from "../../src/server/world/World";
import { applyEvent, type WorldState } from "../../src/server/world/WorldState";
import {
  AGREEMENT_NOTICE_TICKS,
  DEAD_PARTNER_TICKS,
  MARKET_BUY_POINTS,
  MARKET_SELL_POINTS,
  TRUST_MAX,
  TRUST_REGROWTH_PER_DAY,
} from "../../src/shared/config/diplomacy";
import { RESOURCES } from "../../src/shared/config/provinces";
import { RESOURCE_CAP } from "../../src/shared/config/rates";
import { TICKS_PER_DAY } from "../../src/shared/config/time";
import { equipmentIndex } from "../../src/shared/economy/Equipment";
import { mapFixture } from "../util/worldFixture";

/**
 * The trade system: what a standing agreement moves, and what it costs.
 *
 * §6.5, and the two rules that make it a game rather than a transfer: the
 * currency is construction points, so an import is factories not built; and a
 * side that cannot cover its rate scales down instead of breaking anything
 * (invariant 2).
 */
function build(): { world: World; a: number; b: number } {
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
  const world = World.create(fixture.descriptor, fixture.nations, fixture.map);
  return { world, a: 1, b: 2 };
}

/** A standing trade, put straight into the state the way two commands would. */
function agree(
  state: WorldState,
  seller: number,
  buyer: number,
  resourcePerTick: number,
  pointsPerTick: number,
): number {
  applyEvent(state, {
    kind: "agreement_proposed",
    nation: seller,
    other: buyer,
    type: "trade",
    terms: { resource: "material", resourcePerTick, pointsPerTick },
  });
  const id = state.agreements[state.agreements.length - 1].id;
  applyEvent(state, { kind: "agreement_accepted", agreementId: id });
  // Both sides have just spoken, so the dead-partner rule has nothing on them.
  for (const nation of [seller, buyer]) {
    applyEvent(state, { kind: "nation_seen", nation });
  }
  return id;
}

describe("standing trade agreements", () => {
  let world: World;
  let a: number;
  let b: number;

  beforeEach(() => {
    ({ world, a, b } = build());
  });

  test("a trade moves the resource and is paid for in construction points", () => {
    const state = world.view() as WorldState;
    agree(state, a, b, 0.5, 0.25);

    const seller = nationTrade(state, a);
    const buyer = nationTrade(state, b);
    expect(seller.resourceOut.material).toBeCloseTo(0.5);
    expect(seller.pointsIn).toBeCloseTo(0.25);
    expect(buyer.resourceIn.material).toBeCloseTo(0.5);
    expect(buyer.pointsOut).toBeCloseTo(0.25);

    // The price, where §6.5 puts it: the buyer builds more slowly, and by
    // exactly what it agreed to pay.
    const made = measureNation(state, b).construction;
    expect(constructionAvailable(state, b)).toBeCloseTo(made - 0.25);
    expect(constructionAvailable(state, a)).toBeCloseTo(
      measureNation(state, a).construction + 0.25,
    );
  });

  test("equipment rides beside the resource, priced by the same points (§10)", () => {
    const state = world.view() as WorldState;
    applyEvent(state, {
      kind: "agreement_proposed",
      nation: a,
      other: b,
      type: "trade",
      terms: {
        resource: "material",
        resourcePerTick: 0.5,
        pointsPerTick: 0.25,
        equipment: { type: "aircraft", perTick: 1 },
      },
    });
    const id = state.agreements[state.agreements.length - 1].id;
    applyEvent(state, { kind: "agreement_accepted", agreementId: id });
    for (const nation of [a, b])
      applyEvent(state, { kind: "nation_seen", nation });
    const fighter = equipmentIndex("aircraft");
    state.nations[a].stockpile[fighter] = 100;

    const seller = nationTrade(state, a);
    const buyer = nationTrade(state, b);
    expect(seller.resourceOut.material).toBeCloseTo(0.5);
    expect(seller.equipmentOut[fighter]).toBeCloseTo(1);
    expect(buyer.equipmentIn[fighter]).toBeCloseTo(1);
    expect(buyer.pointsOut).toBeCloseTo(0.25);

    // And the tick moves the crates: one stockpile event a nation.
    const events = tradeSystem.run(state, state.tick);
    const moved = events.filter((e) => e.kind === "stockpile_changed") as {
      nation: number;
      delta: [number, number][];
    }[];
    expect(moved.find((e) => e.nation === a)?.delta).toContainEqual([
      fighter,
      -1,
    ]);
    expect(moved.find((e) => e.nation === b)?.delta).toContainEqual([
      fighter,
      1,
    ]);

    // An armoury short of fighters scales the whole exchange (invariant 2):
    // half the aircraft, half the steel, half the price.
    state.nations[a].stockpile[fighter] = 0.5;
    const short = nationTrade(state, a);
    expect(short.equipmentOut[fighter]).toBeCloseTo(0.5);
    expect(short.resourceOut.material).toBeCloseTo(0.25);
    expect(short.pointsIn).toBeCloseTo(0.125);
  });

  test("equipment alone is a trade: the resource rate may be zero", () => {
    const state = world.view() as WorldState;
    applyEvent(state, {
      kind: "agreement_proposed",
      nation: a,
      other: b,
      type: "trade",
      terms: {
        resource: "material",
        resourcePerTick: 0,
        pointsPerTick: 0.25,
        equipment: { type: "infantry", perTick: 2 },
      },
    });
    const id = state.agreements[state.agreements.length - 1].id;
    applyEvent(state, { kind: "agreement_accepted", agreementId: id });
    for (const nation of [a, b])
      applyEvent(state, { kind: "nation_seen", nation });
    const rifles = equipmentIndex("infantry");
    state.nations[a].stockpile[rifles] = 50;
    const seller = nationTrade(state, a);
    expect(seller.resourceOut.material).toBe(0);
    expect(seller.equipmentOut[rifles]).toBeCloseTo(2);
    expect(seller.pointsIn).toBeCloseTo(0.25);
    expect(constructionAvailable(state, b)).toBeCloseTo(
      measureNation(state, b).construction - 0.25,
    );
  });

  test("a side that cannot cover its rate scales the flow, not the agreement", () => {
    const state = world.view() as WorldState;
    const id = agree(state, a, b, 2, 0.25);
    // Half of one tick's rate in the vault, and nothing coming in.
    state.nations[a].resources.material = 1;
    for (const province of state.map.provinces) {
      if (state.provinceController[province.id] !== a) continue;
      province.resourceDeposits.material = 0;
    }

    const flow = nationTrade(state, a);
    expect(flow.resourceOut.material).toBeCloseTo(1);
    // Scaled together: the buyer pays half because it received half.
    expect(flow.pointsIn).toBeCloseTo(0.125);
    expect(nationTrade(state, b).pointsOut).toBeCloseTo(0.125);
    // And the agreement is untouched. Nothing here breaks (invariant 2).
    expect(state.agreements.find((x) => x.id === id)?.accepted).toBe(true);
  });

  test("notice stops the flow a day later, and not before", () => {
    const state = world.view() as WorldState;
    const id = agree(state, a, b, 0.5, 0.25);
    applyEvent(state, {
      kind: "agreement_notice_given",
      agreementId: id,
      nation: b,
    });
    const given = state.tick;

    state.tick = given + AGREEMENT_NOTICE_TICKS - 1;
    expect(nationTrade(state, a).resourceOut.material).toBeCloseTo(0.5);

    state.tick = given + AGREEMENT_NOTICE_TICKS;
    expect(nationTrade(state, a).resourceOut.material).toBe(0);
    // And the record goes when the system next runs, not before: the flow
    // stopping and the record vanishing are the same moment.
    const events = tradeSystem.run(state, state.tick);
    expect(events).toContainEqual({
      kind: "agreement_dissolved",
      agreementId: id,
    });
  });

  test("an agreement with a silent nation dissolves at nobody's cost", () => {
    const state = world.view() as WorldState;
    const id = agree(state, a, b, 0.5, 0.25);
    const trustBefore = [state.nations[a].trust, state.nations[b].trust];

    state.tick = DEAD_PARTNER_TICKS + 2;
    const events = tradeSystem.run(state, state.tick);
    expect(events).toContainEqual({
      kind: "agreement_dissolved",
      agreementId: id,
    });
    // No trust event anywhere in that tick. §6.5 is explicit that the
    // dead-partner rule costs nothing — the partner did not betray anyone,
    // they stopped existing.
    expect(events.some((event) => event.kind === "trust_changed")).toBe(false);
    expect([state.nations[a].trust, state.nations[b].trust]).toEqual(
      trustBefore,
    );
    // And it stops moving anything the same tick it is written off.
    expect(nationTrade(state, a).resourceOut.material).toBe(0);
  });

  test("a capital that changes hands keeps its nation's agreements until the occupation settles (decision 0025)", () => {
    const state = world.view() as WorldState;
    const id = agree(state, a, b, 0.5, 0.25);
    const capital = state.map.provinces.find(
      (province) => province.capital && province.nation === b,
    );
    if (capital === undefined) throw new Error("the fixture has no capital");
    // Somebody else stands in it: held, not owned. The agreement stands.
    applyEvent(state, {
      kind: "control_changed",
      province: capital.id,
      nation: a,
    });
    let events = tradeSystem.run(state, state.tick);
    expect(events.some((event) => event.kind === "agreement_dissolved")).toBe(
      false,
    );
    expect(isDeadPartner(state, b)).toBe(false);
    // Retaken before the occupation settles: nothing was ever lost.
    applyEvent(state, {
      kind: "control_changed",
      province: capital.id,
      nation: b,
    });
    expect(isDeadPartner(state, b)).toBe(false);
    // Held long enough that ownership moved (decision 0002): now it is lost,
    // and the agreement goes at nobody's cost.
    applyEvent(state, {
      kind: "control_changed",
      province: capital.id,
      nation: a,
    });
    applyEvent(state, {
      kind: "owner_changed",
      province: capital.id,
      nation: a,
    });
    const trustBefore = state.nations[b].trust;
    events = tradeSystem.run(state, state.tick);
    expect(events).toContainEqual({
      kind: "agreement_dissolved",
      agreementId: id,
    });
    expect(events.some((event) => event.kind === "trust_changed")).toBe(false);
    expect(state.nations[b].trust).toBe(trustBefore);
  });

  test("trust regrows only if the world says so, and never past the ceiling (decision 0026)", () => {
    const state = world.view() as WorldState;
    applyEvent(state, { kind: "trust_changed", nation: a, delta: -10 });
    // The default: nothing. A default world carries no trust event unless
    // somebody cancelled something.
    expect(trustRegrowth(state, 0)).toEqual([]);
    expect(
      tradeSystem
        .run(state, state.tick)
        .some((e) => e.kind === "trust_changed"),
    ).toBe(TRUST_REGROWTH_PER_DAY > 0);
    // Switched on: one event per nation below the ceiling, a day's worth
    // spread over the day, and the nations already at the ceiling get none.
    const events = trustRegrowth(state, 1);
    expect(events).toEqual([
      { kind: "trust_changed", nation: a, delta: 1 / TICKS_PER_DAY },
    ]);
    for (let i = 0; i < 12 * TICKS_PER_DAY; i++) {
      for (const event of trustRegrowth(state, 1)) applyEvent(state, event);
    }
    expect(state.nations[a].trust).toBe(TRUST_MAX);
    expect(trustRegrowth(state, 1)).toEqual([]);
  });

  test("the world market buys and sells, at a spread that hurts", () => {
    const state = world.view() as WorldState;
    // Small enough that a starting nation can pay for it out of one tick's
    // construction: the market is a fallback, not a fortune.
    applyEvent(state, {
      kind: "market_order_set",
      nation: a,
      resource: "material",
      perTick: 0.1,
    });
    expect(nationTrade(state, a).resourceIn.material).toBeCloseTo(0.1);
    expect(nationTrade(state, a).pointsOut).toBeCloseTo(
      0.1 * MARKET_BUY_POINTS.material,
    );

    applyEvent(state, {
      kind: "market_order_set",
      nation: a,
      resource: "material",
      perTick: -0.1,
    });
    expect(nationTrade(state, a).resourceOut.material).toBeCloseTo(0.1);
    expect(nationTrade(state, a).pointsIn).toBeCloseTo(
      0.1 * MARKET_SELL_POINTS.material,
    );
    // The spread is the whole mechanism: selling back what you bought loses.
    expect(MARKET_SELL_POINTS.material).toBeLessThan(
      MARKET_BUY_POINTS.material,
    );
  });

  test("a market order nobody can afford is filled in part, never refused", () => {
    const state = world.view() as WorldState;
    applyEvent(state, {
      kind: "market_order_set",
      nation: a,
      resource: "material",
      perTick: 1,
    });
    const made = measureNation(state, a).construction;
    const flow = nationTrade(state, a);
    // A tick's construction spent to the last point, and exactly that much
    // steel arriving. Invariant 2: an order too large is not rejected, it is
    // filled as far as the money goes.
    expect(flow.pointsOut).toBeCloseTo(made);
    expect(flow.resourceIn.material).toBeCloseTo(
      made / MARKET_BUY_POINTS.material,
    );
    expect(flow.resourceIn.material).toBeLessThan(1);
    expect(constructionAvailable(state, a)).toBeCloseTo(0);
  });

  test("a nation that promised more points than it makes still builds nothing negative", () => {
    const state = world.view() as WorldState;
    agree(state, a, b, 0.5, 5);
    expect(constructionAvailable(state, b)).toBeGreaterThanOrEqual(0);
    // And it pays only what it has, so the seller is not paid out of thin air.
    const paid = nationTrade(state, b).pointsOut;
    expect(paid).toBeLessThanOrEqual(
      measureNation(state, b).construction + 1e-9,
    );
  });

  test("a partner who cannot deliver does not ration the buyer's market order", () => {
    const state = world.view() as WorldState;
    agree(state, a, b, 2, 1);
    // A has nothing to send and nothing coming: the agreement delivers zero.
    state.nations[a].resources.material = 0;
    for (const province of state.map.provinces) {
      if (state.provinceController[province.id] !== a) continue;
      province.resourceDeposits.material = 0;
    }
    applyEvent(state, {
      kind: "market_order_set",
      nation: b,
      resource: "material",
      perTick: 0.1,
    });

    const flow = nationTrade(state, b);
    // Nothing arrives from A, so nothing is paid to A — and the market order
    // is filled out of the points that were never spent. Rationing B against
    // a bill it will not be sent is what §6.5's fallback is there to avoid.
    expect(flow.pointsOut).toBeCloseTo(0.1 * MARKET_BUY_POINTS.material);
    expect(flow.resourceIn.material).toBeCloseTo(0.1);
  });

  test("a nation with no factories can still pay a partner, out of what it sells", () => {
    const state = world.view() as WorldState;
    // No civilian factories anywhere: construction output is zero.
    state.buildings.fill(0);
    // B buys material from A and owes points for it; B makes none.
    agree(state, a, b, 0.5, 0.25);
    // B sells material of its own to the market, which is where the points
    // come from. With one resource this is the whole shape of §6.5's
    // fallback: you cannot swap one resource for another any more, but you
    // can still turn goods into the currency and the currency into goods.
    applyEvent(state, {
      kind: "market_order_set",
      nation: b,
      resource: "material",
      perTick: -1,
    });

    expect(measureNation(state, b).construction).toBe(0);
    const flow = nationTrade(state, b);
    expect(flow.pointsIn).toBeCloseTo(MARKET_SELL_POINTS.material);
    // And it pays the partner out of that, rather than being cut off:
    // zero civilian factories is not a wall (invariant 2).
    expect(flow.pointsOut).toBeGreaterThan(0);
    expect(flow.resourceIn.material).toBeGreaterThan(0);
  });

  test("a buyer with a full warehouse is not billed for what is discarded", () => {
    const state = world.view() as WorldState;
    agree(state, a, b, 0.5, 0.25);
    // B's steel is at the ceiling; the reducer would clamp anything arriving.
    state.nations[b].resources.material = RESOURCE_CAP;

    const flow = nationTrade(state, b);
    expect(flow.resourceIn.material).toBe(0);
    expect(flow.pointsOut).toBe(0);
    // And the seller keeps what it did not send.
    expect(nationTrade(state, a).resourceOut.material).toBe(0);
  });

  test("a world full of agreements still costs a fraction of a tick", () => {
    const state = world.view() as WorldState;
    // Every nation trading with every other one it can. One agreement per
    // pair rather than two: a nation that sells and buys the same resource at
    // the same rate nets to zero, and a tick that moves nothing would be
    // timing an empty loop.
    for (let seller = 1; seller <= state.nationCount; seller++) {
      for (let buyer = seller + 1; buyer <= state.nationCount; buyer++) {
        agree(state, seller, buyer, 0.1, 0.05);
      }
    }

    const started = performance.now();
    const events = tradeSystem.run(state, state.tick);
    for (let nation = 1; nation <= state.nationCount; nation++) {
      constructionAvailable(state, nation);
    }
    const took = performance.now() - started;
    // Recorded rather than merely asserted. The first version of this system
    // asked "does this nation still hold a capital" once per agreement per
    // share — a walk over every province, several thousand times a tick — and
    // nothing but a number like this one would have caught it.
    expect(
      took,
      `${state.agreements.length} agreements took ${took.toFixed(2)} ms`,
    ).toBeLessThan(50);
    expect(events.length).toBeGreaterThan(0);
  });

  test("over many ticks nothing is created and nothing goes negative", () => {
    const state = world.view() as WorldState;
    agree(state, a, b, 0.5, 0.25);
    applyEvent(state, {
      kind: "market_order_set",
      nation: a,
      resource: "material",
      perTick: -0.5,
    });

    for (let tick = 0; tick < 200; tick++) {
      state.tick++;
      applyEvent(state, { kind: "nation_seen", nation: a });
      applyEvent(state, { kind: "nation_seen", nation: b });
      for (const event of tradeSystem.run(state, state.tick)) {
        applyEvent(state, event);
      }
      for (const nation of [a, b]) {
        for (const resource of RESOURCES) {
          expect(
            state.nations[nation].resources[resource],
          ).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // The agreement outlived two hundred ticks without either side renewing
    // it. That is invariant 3, in the smallest form it can be checked in.
    expect(state.agreements).toHaveLength(1);
  });
});
