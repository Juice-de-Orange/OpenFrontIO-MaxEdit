import { beforeEach, describe, expect, test } from "vitest";
import { combatSystem } from "../../src/server/systems/combat";
import { World, type WorldCommand } from "../../src/server/world/World";
import {
  applyEvent,
  divisionStrength,
  type WorldState,
} from "../../src/server/world/WorldState";
import {
  COMBAT_WIDTH,
  FRONT_ADVANCE,
  FRONT_MARCH_ADVANCE,
} from "../../src/shared/config/combat";
import {
  DIVISION_TEMPLATE,
  equipmentIndex,
} from "../../src/shared/economy/Equipment";
import { mapFixture } from "../util/worldFixture";

/**
 * §6.9: the front, and what decides a province.
 *
 * What is checked here is what the specification is explicit about and what a
 * later phase could quietly undo: that an attack is a standing order rather
 * than an event, that empty ground is walked into and held ground is fought
 * for, that combat width bounds how much force can meet at once, and that the
 * roll is seeded — the tick has to be reproducible from the command log, and a
 * `Math.random()` anywhere near it would make the restore gate meaningless
 * without making it fail.
 */
function build(seed = 1234): {
  world: World;
  map: ReturnType<typeof fixtureMap>;
} {
  const fixture = fixtureMap();
  return {
    world: World.create(fixture.descriptor, fixture.nations, fixture.map, seed),
    map: fixture,
  };
}

function fixtureMap() {
  return mapFixture({
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
}

/** A border this world actually has: who holds it, and who is next to it. */
function border(world: World): {
  attacker: number;
  defender: number;
  province: number;
  from: number;
} {
  const state = world.view();
  for (const province of state.map.provinces) {
    const defender = state.provinceController[province.id];
    if (defender <= 0) continue;
    for (const from of province.neighbours) {
      const attacker = state.provinceController[from];
      if (attacker > 0 && attacker !== defender) {
        return { attacker, defender, province: province.id, from };
      }
    }
  }
  throw new Error("the fixture has no border");
}

/** A division at full template strength, put straight into the state. */
function garrison(state: WorldState, nation: number, province: number): void {
  applyEvent(state, { kind: "division_raised", nation, province });
  const divisions = state.nations[nation].divisions;
  const division = divisions[divisions.length - 1];
  if (division === undefined) throw new Error("no division was raised");
  applyEvent(state, {
    kind: "division_equipment_changed",
    nation,
    divisionId: division.id,
    delta: Object.entries(DIVISION_TEMPLATE).map(([type, wanted]) => [
      equipmentIndex(type as never),
      wanted ?? 0,
    ]) as [number, number][],
  });
}

function order(world: World, nation: number, province: number): void {
  const command: WorldCommand = {
    nation,
    body: { kind: "claim_province", provinceId: province },
  };
  expect(world.rejectionFor(command)).toBeNull();
  world.queueCommand(command);
}

describe("the front", () => {
  let world: World;

  beforeEach(() => {
    ({ world } = build());
  });

  test("ground nobody is holding is marched into at a rate, never flipped", () => {
    const { attacker, province } = border(world);
    const marchTicks = Math.round(1 / FRONT_MARCH_ADVANCE);
    order(world, attacker, province);

    // Invariant 1: even empty ground changes hands as a rate. The march moves
    // one step per tick, the province stays the defender's until it completes,
    // and a player watching the map sees it happen.
    for (let tick = 1; tick < marchTicks; tick++) {
      world.step();
      expect(world.controllerOf(province)).not.toBe(attacker);
      const attack = world.view().nations[attacker].attacks[0];
      expect(attack.progress).toBeCloseTo(tick * FRONT_MARCH_ADVANCE, 10);
    }

    world.step();
    expect(world.controllerOf(province)).toBe(attacker);
    // And the order is spent rather than left standing on ground it took.
    expect(world.view().nations[attacker].attacks).toHaveLength(0);
  });

  test("calling an attack off loses its progress — a front cannot be banked", () => {
    const { attacker, province } = border(world);
    order(world, attacker, province);
    for (let i = 0; i < 3; i++) world.step();
    expect(world.view().nations[attacker].attacks[0].progress).toBeCloseTo(
      3 * FRONT_MARCH_ADVANCE,
      10,
    );

    world.queueCommand({
      nation: attacker,
      body: { kind: "cancel_attack", provinceId: province },
    });
    world.step();
    expect(world.view().nations[attacker].attacks).toHaveLength(0);

    // Re-ordering starts from zero. If progress survived the withdrawal, a
    // player could park a nearly-finished front for free and cash it in
    // later — which is exactly the banking invariant 1's rate is not.
    order(world, attacker, province);
    world.step();
    expect(world.view().nations[attacker].attacks[0].progress).toBeCloseTo(
      FRONT_MARCH_ADVANCE,
      10,
    );
  });

  test("a march into empty ground costs the marchers nothing", () => {
    // The combat system directly, not `world.step()`: supply attrition also
    // empties a division standing away from home, and this test is about
    // what the *march* costs.
    const { attacker, province, from } = border(world);
    const state = world.view() as WorldState;
    garrison(state, attacker, from);
    applyEvent(state, { kind: "attack_ordered", nation: attacker, province });
    const before = divisionStrength(state.nations[attacker].divisions[0]);

    for (let tick = 1; tick <= 4; tick++) {
      for (const event of combatSystem.run(state, tick)) {
        applyEvent(state, event);
      }
    }

    // No battle, no losses: the per-tick cost is what a *fight* costs
    // (invariant 6 wants the footprint on hostile action against somebody),
    // and before the march was a rate the one-tick flip hid the difference.
    expect(state.nations[attacker].attacks[0].progress).toBeCloseTo(
      4 * FRONT_MARCH_ADVANCE,
      10,
    );
    expect(divisionStrength(state.nations[attacker].divisions[0])).toBe(before);
  });

  test("ground somebody is holding is fought for, and the order stands", () => {
    const { attacker, defender, province, from } = border(world);
    const state = world.view() as WorldState;
    // Three defenders and one attacker: the attack cannot win this tick, and
    // must not simply evaporate either.
    for (let i = 0; i < 3; i++) garrison(state, defender, province);
    garrison(state, attacker, from);

    order(world, attacker, province);
    world.step();

    expect(world.controllerOf(province)).toBe(defender);
    expect(world.view().nations[attacker].attacks).toHaveLength(1);
  });

  test("a tick of fighting costs both sides equipment", () => {
    const { attacker, defender, province, from } = border(world);
    const state = world.view() as WorldState;
    for (let i = 0; i < 3; i++) garrison(state, defender, province);
    garrison(state, attacker, from);

    const before = {
      attacker: divisionStrength(state.nations[attacker].divisions[0]),
      defender: divisionStrength(state.nations[defender].divisions[0]),
    };
    order(world, attacker, province);
    world.step();

    // Invariant 6: no hostile action without an economic footprint. Both sides
    // paid, and the attacker paid more for leaving its ground.
    const after = {
      attacker: divisionStrength(state.nations[attacker].divisions[0]),
      defender: divisionStrength(state.nations[defender].divisions[0]),
    };
    expect(after.attacker).toBeLessThan(before.attacker);
    expect(after.defender).toBeLessThan(before.defender);
    expect(before.attacker - after.attacker).toBeGreaterThan(
      before.defender - after.defender,
    );
  });

  test("enough force eventually takes it, and the order ends when it does", () => {
    const { attacker, defender, province, from } = border(world);
    const state = world.view() as WorldState;
    garrison(state, defender, province);
    for (let i = 0; i < COMBAT_WIDTH; i++) garrison(state, attacker, from);

    order(world, attacker, province);
    let taken = false;
    // Three against one moves the front about half its ceiling rate, so the
    // grind needs on the order of 1 / (FRONT_ADVANCE / 2) ticks; three times
    // that is margin for the luck roll, not a tuned number.
    const budget = Math.ceil(6 / FRONT_ADVANCE);
    for (let i = 0; i < budget && !taken; i++) {
      world.step();
      taken = world.controllerOf(province) === attacker;
    }
    expect(taken).toBe(true);
    expect(world.view().nations[attacker].attacks).toHaveLength(0);
  });

  test("combat width bounds what can meet at one border", () => {
    const { attacker, defender, province, from } = border(world);
    const state = world.view() as WorldState;
    for (let i = 0; i < 4; i++) garrison(state, defender, province);
    // Far more than the width, and it still cannot win: a stack is not a
    // hammer, which is the whole of what §6.9 asks combat width for.
    for (let i = 0; i < COMBAT_WIDTH * 5; i++) garrison(state, attacker, from);

    order(world, attacker, province);
    for (let i = 0; i < 5; i++) world.step();
    expect(world.controllerOf(province)).toBe(defender);
  });

  test("the same world rolls the same battle twice", () => {
    // Determinism is the whole basis of the restore: the same seed, the same
    // tick and the same province have to reach the same answer, or a replayed
    // command log lands in a different world from the one it came from.
    const outcomes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { world: twin } = build(4242);
      const { attacker, defender, province, from } = border(twin);
      const state = twin.view() as WorldState;
      garrison(state, defender, province);
      garrison(state, attacker, from);
      order(twin, attacker, province);
      for (let i = 0; i < 25; i++) twin.step();
      outcomes.push(
        `${twin.controllerOf(province)}:${twin.stateHash().toString(16)}`,
      );
    }
    expect(outcomes[0]).toBe(outcomes[1]);
  });

  test("a different world does not", () => {
    // And the seed is what makes them different: two seasons on the same map
    // must not fight the same war tick for tick.
    const hashes = [1, 2].map((seed) => {
      const { world: twin } = build(seed * 99991);
      const { attacker, defender, province, from } = border(twin);
      const state = twin.view() as WorldState;
      for (let i = 0; i < 2; i++) garrison(state, defender, province);
      garrison(state, attacker, from);
      order(twin, attacker, province);
      for (let i = 0; i < 30; i++) twin.step();
      return twin.stateHash();
    });
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("an attack can be called off", () => {
    const { attacker, defender, province, from } = border(world);
    const state = world.view() as WorldState;
    for (let i = 0; i < 3; i++) garrison(state, defender, province);
    garrison(state, attacker, from);

    order(world, attacker, province);
    world.step();
    expect(world.view().nations[attacker].attacks).toHaveLength(1);

    const off: WorldCommand = {
      nation: attacker,
      body: { kind: "cancel_attack", provinceId: province },
    };
    expect(world.rejectionFor(off)).toBeNull();
    world.queueCommand(off);
    world.step();
    expect(world.view().nations[attacker].attacks).toHaveLength(0);
  });

  test("an unattended world does not move at all", () => {
    // The border drift is gone (decision 0014). Nothing takes a province
    // unless somebody orders it, which is what phase 10's regent is for.
    const before = world.controllerSnapshot();
    for (let i = 0; i < 200; i++) world.step();
    expect(world.controllerSnapshot()).toEqual(before);
  });
});

describe("the battle report (decision 0023)", () => {
  let world: World;

  beforeEach(() => {
    ({ world } = build());
  });

  test("a contested tick reports one battle, with both sides' numbers", () => {
    const { attacker, defender, province, from } = border(world);
    const state = world.view() as WorldState;
    garrison(state, defender, province);
    garrison(state, attacker, from);
    order(world, attacker, province);

    const changes = world.step();
    const reports = changes.events.filter(
      (event) => event.kind === "battle_resolved",
    );
    expect(reports).toHaveLength(1);
    const report = reports[0];
    if (report.kind !== "battle_resolved") throw new Error("unreachable");
    expect(report).toMatchObject({ province, attacker, defender });
    expect(report.attackerStrength).toBeGreaterThan(0);
    expect(report.defenderStrength).toBeGreaterThan(0);
    // A battle costs both sides (§6.3), and the report says how much.
    expect(report.attackerLoss).toBeGreaterThan(0);
    expect(report.defenderLoss).toBeGreaterThan(0);
    // The advance is the same number the front moved by.
    const attack = world.view().nations[attacker].attacks[0];
    expect(attack.progress).toBeCloseTo(Math.max(0, report.advance), 10);
    // Signed modifiers, not multipliers: level ground is 0, not 1.
    expect(Math.abs(report.terrain)).toBeLessThan(1);
    expect(Math.abs(report.air)).toBeLessThan(1);
  });

  test("a march into empty ground is not a battle and files no report", () => {
    const { attacker, province } = border(world);
    order(world, attacker, province);
    const changes = world.step();
    expect(
      changes.events.some((event) => event.kind === "battle_resolved"),
    ).toBe(false);
  });

  test("the report changes nothing: applying it is a no-op", () => {
    const state = world.view() as WorldState;
    const before = JSON.stringify(state.nations.map((n) => n.attacks));
    applyEvent(state, {
      kind: "battle_resolved",
      province: 0,
      attacker: 1,
      defender: 2,
      attackerStrength: 1,
      defenderStrength: 1,
      terrain: 0,
      air: 0,
      advance: 0.01,
      attackerLoss: 1,
      defenderLoss: 1,
    });
    expect(JSON.stringify(state.nations.map((n) => n.attacks))).toBe(before);
  });
});
