import { beforeEach, describe, expect, test } from "vitest";
import { airSystem } from "../../src/server/systems/air";
import { supplyReach } from "../../src/server/systems/supply";
import {
  contestOf,
  missionEffect,
  superiorityOf,
  zoneInReach,
  zoneNeighbours,
} from "../../src/server/systems/zones";
import { World, type WorldCommand } from "../../src/server/world/World";
import {
  applyEvent,
  formationStrength,
  type WorldState,
} from "../../src/server/world/WorldState";
import {
  SUPERIORITY_CEILING,
  SUPERIORITY_FLOOR,
} from "../../src/shared/config/air";
import {
  DIVISION_TEMPLATE,
  equipmentIndex,
} from "../../src/shared/economy/Equipment";
import { FORMATIONS } from "../../src/shared/economy/Formations";
import { mapFixture } from "../util/worldFixture";

/**
 * §6.7: air zones, and what superiority over one is worth.
 *
 * The zone machine is shared with phase 9 (§6.8), so what is checked here is
 * split in two: the parts that belong to *any* zoned system — reach, the
 * contest, the ratio, saturation — and the parts that are air's own, which is
 * the three effects and what a tick in a contested sky costs.
 *
 * The load-bearing check is the last one. §8's gate asks that air superiority
 * *measurably* shift a ground battle, and the way that goes wrong is a
 * multiplier that is computed, published, and then never reaches the roll.
 */
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

function build(seed = 1234): World {
  const fixture = fixtureMap();
  return World.create(fixture.descriptor, fixture.nations, fixture.map, seed);
}

/** A border this world actually has. */
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

/** A formation at full template strength, put straight into the state. */
function wing(
  state: WorldState,
  nation: number,
  base: number,
  template: "wing" | "wing",
  zone: number | null,
  mission: Parameters<typeof missionEffect>[3] | null,
): number {
  applyEvent(state, { kind: "formation_raised", nation, template, base });
  const formations = state.nations[nation].formations;
  const formation = formations[formations.length - 1];
  applyEvent(state, {
    kind: "formation_equipment_changed",
    nation,
    formationId: formation.id,
    delta: Object.entries(FORMATIONS[template].equipment).map(
      ([type, wanted]) => [equipmentIndex(type as never), wanted ?? 0],
    ) as [number, number][],
  });
  if (zone !== null && mission !== null) {
    applyEvent(state, {
      kind: "formation_assigned",
      nation,
      formationId: formation.id,
      zone,
      mission,
    });
  }
  return formation.id;
}

function garrison(state: WorldState, nation: number, province: number): void {
  applyEvent(state, { kind: "division_raised", nation, province });
  const divisions = state.nations[nation].divisions;
  const division = divisions[divisions.length - 1];
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

describe("the zone machine", () => {
  let world: World;

  beforeEach(() => {
    world = build();
  });

  test("every province is in an air zone, and zones have neighbours", () => {
    const state = world.view();
    for (const province of state.map.provinces) {
      expect(province.airZone).toBeGreaterThanOrEqual(0);
      expect(province.airZone).toBeLessThan(state.map.airZoneCount);
    }
    const neighbours = zoneNeighbours(state.map, "air");
    expect(neighbours.size).toBeGreaterThan(0);
    // A zone is its own neighbour, which is what makes `ZONE_REACH` include
    // the zone the base is standing in.
    for (const [zone, set] of neighbours) expect(set.has(zone)).toBe(true);
  });

  test("a base reaches its own zone and the ones beside it, and no further", () => {
    const state = world.view();
    const base = state.map.provinces[0];
    expect(zoneInReach(state.map, base.id, base.airZone, "air")).toBe(true);

    const near = zoneNeighbours(state.map, "air").get(base.airZone);
    if (near === undefined) throw new Error("the base's zone has no entry");
    for (const zone of near) {
      expect(zoneInReach(state.map, base.id, zone, "air")).toBe(true);
    }
    // Some zone this base cannot reach, if the map has one at all.
    const far = [...Array(state.map.airZoneCount).keys()].find(
      (zone) => !near.has(zone),
    );
    if (far !== undefined) {
      expect(zoneInReach(state.map, base.id, far, "air")).toBe(false);
    }
  });

  test("an empty zone is a stalemate, not a win for nobody", () => {
    const contest = contestOf(world.view(), 0, "air");
    expect(contest.size).toBe(0);
    expect(superiorityOf(contest, 1)).toBe(0.5);
  });

  test("superiority is clamped at both ends, so the last wing still counts", () => {
    const state = world.view();
    const base = state.map.provinces.find(
      (province) => state.provinceController[province.id] > 0,
    );
    if (base === undefined) throw new Error("no held province");
    const nation = state.provinceController[base.id];
    const zone = base.airZone;

    wing(state, nation, base.id, "wing", zone, "air_superiority");
    // Alone in the sky: the ceiling, and not 1.
    let contest = contestOf(state, zone, "air");
    expect(superiorityOf(contest, nation)).toBe(SUPERIORITY_CEILING);

    // A nation with nothing there gets the floor, and not 0.
    const other = nation === 1 ? 2 : 1;
    expect(superiorityOf(contest, other)).toBe(SUPERIORITY_FLOOR);

    // Matched: half each. Invariant 2 read as a ratio.
    const theirs = state.map.provinces.find(
      (province) => state.provinceController[province.id] === other,
    );
    if (theirs !== undefined) {
      wing(state, other, theirs.id, "wing", zone, "air_superiority");
      contest = contestOf(state, zone, "air");
      expect(superiorityOf(contest, nation)).toBeCloseTo(0.5, 6);
    }
  });

  test("a wing standing down contributes nothing and is not in the contest", () => {
    const state = world.view();
    const base = state.map.provinces.find(
      (province) => state.provinceController[province.id] > 0,
    );
    if (base === undefined) throw new Error("no held province");
    const nation = state.provinceController[base.id];
    wing(state, nation, base.id, "wing", null, null);
    expect(contestOf(state, base.airZone, "air").size).toBe(0);
  });

  test("a second wing on a mission adds less than the first", () => {
    const state = world.view();
    const base = state.map.provinces.find(
      (province) => state.provinceController[province.id] > 0,
    );
    if (base === undefined) throw new Error("no held province");
    const nation = state.provinceController[base.id];
    const zone = base.airZone;

    wing(state, nation, base.id, "wing", zone, "ground_support");
    const one = missionEffect(state, zone, nation, "ground_support", "air");
    wing(state, nation, base.id, "wing", zone, "ground_support");
    const two = missionEffect(state, zone, nation, "ground_support", "air");

    expect(two).toBeGreaterThan(one);
    // Diminishing: the second wing is worth less than the first was.
    expect(two - one).toBeLessThan(one);
    expect(two).toBeLessThan(1);
  });
});

describe("the air war", () => {
  test("a contested sky costs equipment; an empty one does not", () => {
    const world = build();
    const state = world.view();
    const held = state.map.provinces.filter(
      (province) => state.provinceController[province.id] > 0,
    );
    const mine = held[0];
    const nation = state.provinceController[mine.id];
    const zone = mine.airZone;

    const id = wing(state, nation, mine.id, "wing", zone, "air_superiority");
    const formation = state.nations[nation].formations.find((f) => f.id === id);
    if (formation === undefined) throw new Error("no formation");

    // Alone: nothing is lost.
    for (const event of airSystem.run(state, 1)) applyEvent(state, event);
    expect(formationStrength(formation)).toBe(1);

    // Now somebody else turns up over the same zone.
    const theirs = held.find(
      (province) => state.provinceController[province.id] !== nation,
    );
    if (theirs === undefined) throw new Error("no second nation");
    const other = state.provinceController[theirs.id];
    wing(state, other, theirs.id, "wing", zone, "air_superiority");

    for (const event of airSystem.run(state, 2)) applyEvent(state, event);
    expect(formationStrength(formation)).toBeLessThan(1);
    expect(formationStrength(formation)).toBeGreaterThan(0);
  });

  test("losing the ground under a base sends the wing home", () => {
    const world = build();
    const state = world.view();
    const mine = state.map.provinces.find(
      (province) => state.provinceController[province.id] > 0,
    );
    if (mine === undefined) throw new Error("no held province");
    const nation = state.provinceController[mine.id];

    const id = wing(
      state,
      nation,
      mine.id,
      "wing",
      mine.airZone,
      "air_superiority",
    );
    applyEvent(state, {
      kind: "control_changed",
      province: mine.id,
      nation: nation === 1 ? 2 : 1,
    });

    for (const event of airSystem.run(state, 3)) applyEvent(state, event);
    const formation = state.nations[nation].formations.find((f) => f.id === id);
    expect(formation?.zone).toBeNull();
    expect(formation?.mission).toBeNull();
    // Sent home, not shot down: the aircraft are still the nation's.
    expect(formationStrength(formation!)).toBe(1);
  });

  test("interdiction cuts supply without ever cutting it off", () => {
    const world = build();
    const state = world.view();
    const { attacker, defender, province } = border(world);

    const before = supplyReach(state, defender).get(province) ?? 0;
    expect(before).toBeGreaterThan(0);

    const base = state.map.provinces.find(
      (candidate) => state.provinceController[candidate.id] === attacker,
    );
    if (base === undefined) throw new Error("the attacker holds nothing");
    // Enough wings that the cap is what is being tested, not the ramp.
    for (let i = 0; i < 6; i++) {
      wing(
        state,
        attacker,
        base.id,
        "wing",
        state.map.provinces[province].airZone,
        "ground_support",
      );
    }

    const after = supplyReach(state, defender).get(province) ?? 0;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  test("air superiority measurably shifts a ground battle — §8's gate, in one test", () => {
    const { attacker, defender, province, from } = border(build());
    const WINDOW = 24;

    /**
     * The same fight twice, with and without bombers over it.
     *
     * Since the front became a rate (invariant 1), what the sky changes is
     * how fast the line moves: the ground-support multiplier raises `pressed`
     * and with it every tick's advance. The two runs build identical worlds,
     * so the luck rolls and the attrition are the same in both and the
     * bombers are the only thing that differs — the progress the front made
     * inside the window is then a clean reading of the air alone.
     *
     * The attacker is taken down to `share` of a division because a fight one
     * side wins at the ceiling rate proves nothing: the advance is capped,
     * and both runs would sit at the cap together.
     */
    const fight = (support: boolean, share: number): number => {
      const world = build();
      const state = world.view();
      garrison(state, defender, province);
      garrison(state, attacker, from);

      // Take the attacker back down to `share` of a division.
      const divisions = state.nations[attacker].divisions;
      const division = divisions[divisions.length - 1];
      applyEvent(state, {
        kind: "division_equipment_changed",
        nation: attacker,
        divisionId: division.id,
        delta: division.equipment.map((held, index) => [
          index,
          -held * (1 - share),
        ]) as [number, number][],
      });

      if (support) {
        for (let i = 0; i < 4; i++) {
          wing(
            state,
            attacker,
            from,
            "wing",
            state.map.provinces[province].airZone,
            "ground_support",
          );
        }
      }

      const command: WorldCommand = {
        nation: attacker,
        body: { kind: "claim_province", provinceId: province },
      };
      expect(world.rejectionFor(command)).toBeNull();
      world.queueCommand(command);

      for (
        let tick = 0;
        tick < WINDOW && world.controllerOf(province) === defender;
        tick++
      ) {
        world.step();
      }
      // Completed inside the window counts as the whole province.
      const attack = world
        .view()
        .nations[attacker].attacks.find((it) => it.province === province);
      return attack?.progress ?? 1;
    };

    // Somewhere in here is a fight the bombers visibly speed up. Walking the
    // range rather than hard-coding one share keeps the test alive when the
    // combat constants are retuned — which they will be, repeatedly.
    let decided: { share: number; alone: number; supported: number } | null =
      null;
    for (const share of [1, 0.95, 0.9, 0.85, 0.8, 0.75]) {
      const alone = fight(false, share);
      const supported = fight(true, share);
      if (supported >= alone + 0.01) {
        decided = { share, alone, supported };
        break;
      }
    }

    expect(
      decided,
      "no attacker strength was found where the bombers moved the front further",
    ).not.toBeNull();
  });
});
