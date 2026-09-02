import { beforeEach, describe, expect, test } from "vitest";
import { World, type WorldCommand } from "../../src/server/world/World";
import {
  applyEvent,
  atPeace,
  type WorldState,
} from "../../src/server/world/WorldState";
import {
  AGREEMENT_NOTICE_TICKS,
  MAX_TRADE_EQUIPMENT_PER_TICK,
  TRUST_COST,
  TRUST_START,
} from "../../src/shared/config/diplomacy";
import { CommandBodySchema } from "../../src/shared/protocol/Wire";
import { mapFixture } from "../util/worldFixture";

/**
 * The diplomacy commands, and the promises they make binding.
 *
 * §6.5 and §6.9. What is checked here is what the spec is explicit about and
 * what a later phase could quietly break: that nothing expires, that breaking
 * a promise costs exactly what it says it costs, that an attack on a nation
 * you have promised not to attack is refused at validation rather than
 * regretted afterwards, and that all of it survives a restore — §4 puts
 * diplomatic state in the snapshot *and* asks for it to be derivable from the
 * command log.
 */
function build(): World {
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
  return World.create(fixture.descriptor, fixture.nations, fixture.map);
}

/** Send a command the way the socket would: validate, queue, run the tick. */
function send(world: World, command: WorldCommand): string | null {
  const rejection = world.rejectionFor(command);
  if (rejection !== null) return rejection;
  world.queueCommand(command);
  world.step();
  return null;
}

/** Two nations that actually share a border on this fixture. */
function neighbours(world: World): {
  attacker: number;
  defender: number;
  province: number;
} {
  const state = world.view();
  for (const province of state.map.provinces) {
    const defender = state.provinceController[province.id];
    if (defender <= 0) continue;
    for (const next of province.neighbours) {
      const attacker = state.provinceController[next];
      if (attacker > 0 && attacker !== defender) {
        return { attacker, defender, province: province.id };
      }
    }
  }
  throw new Error("the fixture has no shared border to test with");
}

/** Whether a nation still holds a capital — the other half of §6.5's rule. */
function holdsCapital(world: World, nation: number): boolean {
  const state = world.view();
  return state.map.provinces.some(
    (province) =>
      province.capital && state.provinceController[province.id] === nation,
  );
}

function agreementId(world: World): number {
  const state = world.view();
  expect(state.agreements.length).toBeGreaterThan(0);
  return state.agreements[state.agreements.length - 1].id;
}

describe("agreements", () => {
  let world: World;

  beforeEach(() => {
    world = build();
  });

  test("an offer is not an agreement until the other side accepts it", () => {
    expect(
      send(world, {
        nation: 1,
        body: { kind: "propose_agreement", to: 2, type: "non_aggression" },
      }),
    ).toBeNull();
    const id = agreementId(world);
    expect(world.view().agreements[0].accepted).toBe(false);
    // And it binds nobody yet: §6.9's refusal only follows acceptance.
    expect(atPeace(world.view(), 1, 2)).toBe(false);

    // Not the proposer's to accept, either.
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "accept_agreement", agreementId: id },
      }),
    ).toMatch(/not made to you/);

    expect(
      send(world, {
        nation: 2,
        body: { kind: "accept_agreement", agreementId: id },
      }),
    ).toBeNull();
    expect(atPeace(world.view(), 1, 2)).toBe(true);
  });

  test("an attack on a nation you promised not to attack is refused", () => {
    const { attacker, defender, province } = neighbours(world);
    send(world, {
      nation: attacker,
      body: {
        kind: "propose_agreement",
        to: defender,
        type: "non_aggression",
      },
    });
    const id = agreementId(world);
    send(world, {
      nation: defender,
      body: { kind: "accept_agreement", agreementId: id },
    });

    const claim: WorldCommand = {
      nation: attacker,
      body: { kind: "claim_province", provinceId: province },
    };
    expect(world.rejectionFor(claim)).toMatch(/cancel it first/);

    // Cancelling opens the door, but not today: the notice runs a full day,
    // so the attack is announced before it can land.
    send(world, {
      nation: attacker,
      body: { kind: "cancel_agreement", agreementId: id },
    });
    expect(world.rejectionFor(claim)).toMatch(/cancel it first/);
    for (let i = 0; i < AGREEMENT_NOTICE_TICKS; i++) world.step();
    // The province may have changed hands in the meantime — the world does not
    // hold still for a test — so what is asserted is the promise and not the
    // border: whatever refuses this claim now, it is no longer the agreement.
    expect(world.rejectionFor(claim) ?? "").not.toMatch(/cancel it first/);
  });

  test("signing peace calls off an attack that is already grinding", () => {
    const { attacker, defender, province } = neighbours(world);

    // The order comes first, so the pact arrives on a war in progress. §6.9
    // refuses a *new* attack on a partner; this is the other half — an order
    // given before the promise must not go on taking provinces after it, or
    // the promise is worth nothing in the one place it matters.
    // A division holds the province *first*, so the attack grinds rather than
    // walking into empty ground on the tick it is given.
    applyEvent(world.view() as WorldState, {
      kind: "division_raised",
      nation: defender,
      province,
    });
    send(world, {
      nation: attacker,
      body: { kind: "claim_province", provinceId: province },
    });
    expect(world.view().nations[attacker].attacks).toHaveLength(1);

    send(world, {
      nation: attacker,
      body: {
        kind: "propose_agreement",
        to: defender,
        type: "non_aggression",
      },
    });
    send(world, {
      nation: defender,
      body: { kind: "accept_agreement", agreementId: agreementId(world) },
    });

    expect(atPeace(world.view(), attacker, defender)).toBe(true);
    world.step();
    expect(world.view().nations[attacker].attacks).toHaveLength(0);
    expect(world.controllerOf(province)).toBe(defender);
  });

  test("cancelling costs exactly what the spec says, and only once", () => {
    send(world, {
      nation: 1,
      body: { kind: "propose_agreement", to: 2, type: "alliance" },
    });
    const id = agreementId(world);
    send(world, {
      nation: 2,
      body: { kind: "accept_agreement", agreementId: id },
    });
    expect(world.view().nations[1].trust).toBe(TRUST_START);

    send(world, {
      nation: 1,
      body: { kind: "cancel_agreement", agreementId: id },
    });
    expect(world.view().nations[1].trust).toBe(
      TRUST_START - TRUST_COST.alliance,
    );
    // The other side pays nothing for being left.
    expect(world.view().nations[2].trust).toBe(TRUST_START);
    // And notice cannot be given twice to restart the clock or pay twice.
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "cancel_agreement", agreementId: id },
      }),
    ).toMatch(/already given notice/);
  });

  test("breaking a non-aggression pact costs more than breaking an alliance", () => {
    // §6.5's own ordering, and the surprising half of it: there is only one
    // reason to tear up a non-aggression pact and everybody can see what it is.
    expect(TRUST_COST.non_aggression).toBeGreaterThan(TRUST_COST.alliance);
    expect(TRUST_COST.alliance).toBeGreaterThan(TRUST_COST.trade);
  });

  test("the same agreement cannot be offered twice, in one tick or ever", () => {
    const offer: WorldCommand = {
      nation: 1,
      body: { kind: "propose_agreement", to: 2, type: "military_access" },
    };
    expect(world.rejectionFor(offer)).toBeNull();
    world.queueCommand(offer);
    // Accepted for the same tick, and not applied yet: the validator has to
    // see it anyway, or the second is acked and then silently dropped.
    expect(world.rejectionFor(offer)).toMatch(/already offered/);
    world.step();
    expect(world.rejectionFor(offer)).toMatch(/already have/);
  });

  test("a trade offer without terms is refused, and so are terms without a trade", () => {
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "propose_agreement", to: 2, type: "trade" },
      }),
    ).toMatch(/needs terms/);
    expect(
      world.rejectionFor({
        nation: 1,
        body: {
          kind: "propose_agreement",
          to: 2,
          type: "alliance",
          terms: {
            resource: "material",
            resourcePerTick: 1,
            pointsPerTick: 1,
          },
        },
      }),
    ).toMatch(/carries no terms/);
  });

  test("nothing expires: an accepted agreement outlives a long silence in the state", () => {
    send(world, {
      nation: 1,
      body: {
        kind: "propose_agreement",
        to: 2,
        type: "trade",
        terms: {
          resource: "material",
          resourcePerTick: 0.5,
          pointsPerTick: 0.25,
        },
      },
    });
    const id = agreementId(world);
    send(world, {
      nation: 2,
      body: { kind: "accept_agreement", agreementId: id },
    });

    let bothStoodThroughout = true;
    for (let i = 0; i < 300; i++) {
      // Both sides keep saying they are there; §6.5's dead-partner rule is
      // about absence, not about time passing.
      world.queueCommand({ nation: 1, body: { kind: "nation_present" } });
      world.queueCommand({ nation: 2, body: { kind: "nation_present" } });
      world.step();
      // Checked every tick, not at the end. The other half of the rule is
      // "has lost its capital", and on this fixture the border drift can take
      // one and hand it back a few ticks later — by which time the agreement
      // is already, and correctly, gone.
      if (!holdsCapital(world, 1) || !holdsCapital(world, 2)) {
        bothStoodThroughout = false;
      }
    }

    // The claim, stated exactly: for as long as both sides were still there,
    // so was the agreement — twelve in-game days of it, with no renewal from
    // either and nothing in the system that could expire.
    const standing = world.view().agreements.find((a) => a.id === id);
    if (bothStoodThroughout) {
      expect(standing?.accepted).toBe(true);
      expect(standing?.noticeAt).toBeNull();
    } else {
      expect(standing).toBeUndefined();
    }
  });

  test("a trade in the other direction is a different agreement", () => {
    const terms = {
      resource: "material" as const,
      resourcePerTick: 0.5,
      pointsPerTick: 0.25,
    };
    expect(
      send(world, {
        nation: 1,
        body: { kind: "propose_agreement", to: 2, type: "trade", terms },
      }),
    ).toBeNull();
    send(world, {
      nation: 2,
      body: { kind: "accept_agreement", agreementId: agreementId(world) },
    });

    // The same lane again is a duplicate and is refused.
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "propose_agreement", to: 2, type: "trade", terms },
      }),
    ).toMatch(/already have/);

    // The other way round is not: `parties[0]` sends and `parties[1]` pays, so
    // this is a different bargain. Two nations must be able to trade both
    // ways rather than being pushed onto the market at four times the price.
    expect(
      world.rejectionFor({
        nation: 2,
        body: {
          kind: "propose_agreement",
          to: 1,
          type: "trade",
          terms: { ...terms, resource: "material" },
        },
      }),
    ).toBeNull();
  });

  test("offers from others cannot use up your own limit", () => {
    // Twenty-four nations cannot be summoned on this fixture, so the shape is
    // checked instead: what counts towards the limit is what this nation
    // brought about, and a received offer is not that.
    send(world, {
      nation: 2,
      body: { kind: "propose_agreement", to: 1, type: "alliance" },
    });
    send(world, {
      nation: 3,
      body: { kind: "propose_agreement", to: 1, type: "non_aggression" },
    });
    const mine = world
      .view()
      .agreements.filter(
        (a) => a.parties.includes(1) && (a.accepted || a.parties[0] === 1),
      );
    expect(world.view().agreements).toHaveLength(2);
    expect(mine).toHaveLength(0);
    // And nation 1 can still make its own offer.
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "propose_agreement", to: 4, type: "military_access" },
      }),
    ).toBeNull();
  });

  test("a rate the world will not take is refused, never fatal", () => {
    // These used to be schema failures, and a schema failure closes the socket
    // with CloseCode.Malformed — which the client treats as terminal. A number
    // the world dislikes is a game rule, and game rules are answered (§7).
    for (const terms of [
      { resource: "material" as const, resourcePerTick: 0, pointsPerTick: 1 },
      { resource: "material" as const, resourcePerTick: 1, pointsPerTick: 0 },
      { resource: "material" as const, resourcePerTick: 999, pointsPerTick: 1 },
      { resource: "material" as const, resourcePerTick: 1, pointsPerTick: -3 },
    ]) {
      const body = {
        kind: "propose_agreement" as const,
        to: 2,
        type: "trade" as const,
        terms,
      };
      expect(CommandBodySchema.safeParse(body).success).toBe(true);
      expect(world.rejectionFor({ nation: 1, body })).toMatch(/a day/);
    }
    const market = {
      kind: "set_market_order" as const,
      resource: "material" as const,
      perTick: 500,
    };
    expect(CommandBodySchema.safeParse(market).success).toBe(true);
    expect(world.rejectionFor({ nation: 1, body: market })).toMatch(/a day/);
  });

  test("equipment terms obey their own ceiling, need a rate, and are one lane each (§10)", () => {
    const offer = (terms: unknown): string | null =>
      world.rejectionFor({
        nation: 1,
        body: {
          kind: "propose_agreement",
          to: 2,
          type: "trade",
          terms: terms as never,
        },
      });
    const rifles = (perTick: number, resourcePerTick = 0) => ({
      resource: "material" as const,
      resourcePerTick,
      pointsPerTick: 1,
      equipment: { type: "infantry_equipment" as const, perTick },
    });
    // The ceiling is the equipment's own, and it is lower than a resource's.
    expect(offer(rifles(0))).toMatch(/a day/);
    expect(offer(rifles(MAX_TRADE_EQUIPMENT_PER_TICK + 1))).toMatch(/a day/);
    expect(offer(rifles(-1))).toMatch(/a day/);
    // A resource rate of zero is fine when equipment rides, and refused alone.
    expect(offer(rifles(1))).toBeNull();
    expect(
      offer({ resource: "material", resourcePerTick: 0, pointsPerTick: 1 }),
    ).toMatch(/a day/);
    // The shape passes the wire either way: limits are the world's (§7).
    expect(
      CommandBodySchema.safeParse({
        kind: "propose_agreement",
        to: 2,
        type: "trade",
        terms: rifles(99),
      }).success,
    ).toBe(true);

    // One lane per goods: rifles twice is a duplicate, rifles beside a plain
    // steel trade is not.
    send(world, {
      nation: 1,
      body: {
        kind: "propose_agreement",
        to: 2,
        type: "trade",
        terms: rifles(1),
      },
    });
    expect(offer(rifles(1))).toMatch(/already/);
    expect(
      offer({ resource: "material", resourcePerTick: 1, pointsPerTick: 1 }),
    ).toBeNull();
  });

  test("agreements, trust and market orders come back from a snapshot", () => {
    send(world, {
      nation: 1,
      body: {
        kind: "propose_agreement",
        to: 2,
        type: "trade",
        terms: {
          resource: "material",
          resourcePerTick: 0.5,
          pointsPerTick: 1,
          equipment: { type: "fighter", perTick: 0.5 },
        },
      },
    });
    const id = agreementId(world);
    send(world, {
      nation: 2,
      body: { kind: "accept_agreement", agreementId: id },
    });
    send(world, {
      nation: 1,
      body: { kind: "set_market_order", resource: "material", perTick: -0.25 },
    });
    send(world, {
      nation: 2,
      body: { kind: "propose_agreement", to: 3, type: "alliance" },
    });
    const second = agreementId(world);
    send(world, {
      nation: 3,
      body: { kind: "accept_agreement", agreementId: second },
    });
    send(world, {
      nation: 2,
      body: { kind: "cancel_agreement", agreementId: second },
    });

    const before = world.stateHash();
    const snapshot = world.snapshot();
    const restored = build();
    restored.restoreFrom(snapshot);

    // The hash is the whole assertion: every field of the state goes into it,
    // so a world that came back having forgotten a promise cannot match.
    expect(restored.stateHash()).toBe(before);
    const agreement = restored.view().agreements.find((a) => a.id === id);
    expect(agreement?.terms?.resource).toBe("material");
    expect(agreement?.terms?.equipment).toEqual({
      type: "fighter",
      perTick: 0.5,
    });
    // The hash knows the equipment: a world that forgot the fighters differs.
    const forgetful = build();
    forgetful.restoreFrom({
      ...snapshot,
      agreements: (snapshot.agreements ?? []).map((a) => ({
        ...a,
        terms: a.terms === null ? null : { ...a.terms, equipment: undefined },
      })),
    });
    expect(forgetful.stateHash()).not.toBe(before);
    expect(restored.view().nations[2].trust).toBe(
      TRUST_START - TRUST_COST.alliance,
    );
    expect(restored.view().nations[1].market.material).toBe(-0.25);
    // And the next agreement gets a fresh id rather than reusing one.
    expect(restored.view().nextAgreementId).toBe(world.view().nextAgreementId);
  });

  test("no agreement ever names a nation that is not in this world", () => {
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "propose_agreement", to: 99, type: "alliance" },
      }),
    ).toMatch(/no nation 99/);
    expect(
      world.rejectionFor({
        nation: 1,
        body: { kind: "propose_agreement", to: 1, type: "alliance" },
      }),
    ).toMatch(/with itself/);

    for (let i = 0; i < 50; i++) world.step();
    for (const agreement of world.view().agreements) {
      for (const party of agreement.parties) {
        expect(party).toBeGreaterThan(0);
        expect(party).toBeLessThanOrEqual(world.nations.length);
      }
    }
  });
});
