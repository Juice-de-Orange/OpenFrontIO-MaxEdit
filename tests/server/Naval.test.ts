import { beforeEach, describe, expect, test } from "vitest";
import { navalSystem } from "../../src/server/systems/naval";
import { tradeRouteBetween } from "../../src/server/systems/routes";
import { seaSupplyRoutes, supplyReach } from "../../src/server/systems/supply";
import { nationTrade } from "../../src/server/systems/trade";
import { World } from "../../src/server/world/World";
import {
  applyEvent,
  AT_SEA,
  type Division,
  type Formation,
  type WorldState,
} from "../../src/server/world/WorldState";
import {
  INVASION_LANDING_FACTOR,
  INVASION_TICKS_PER_ZONE,
  SEA_SUPPLY_FLOOR,
} from "../../src/shared/config/naval";
import {
  BUILDING_TYPES,
  buildingIndex,
  type BuildingType,
} from "../../src/shared/economy/Buildings";
import { equipmentIndex } from "../../src/shared/economy/Equipment";
import {
  FORMATIONS,
  type FormationTemplate,
  type Mission,
} from "../../src/shared/economy/Formations";
import { islandFixture } from "../util/worldFixture";

/**
 * The sea half of phase 9, on two islands with a real ocean between them.
 *
 * Everything here drives the systems directly rather than through
 * `world.step()` — stepping runs supply attrition and combat too, and a
 * reading that mixes three systems measures none of them (the phase-4 trap,
 * still paid for).
 */
function build(): { world: World; state: WorldState } {
  const fixture = islandFixture();
  const world = World.create(
    fixture.descriptor,
    fixture.nations,
    fixture.map,
    99,
  );
  return { world, state: world.view() as WorldState };
}

function setBuilding(
  state: WorldState,
  province: number,
  building: BuildingType,
  count: number,
): void {
  state.buildings[province * BUILDING_TYPES.length + buildingIndex(building)] =
    count;
}

/** A coastal province this nation both owns and controls. */
function coastalOf(state: WorldState, nation: number): number {
  const found = state.map.provinces.find(
    (p) =>
      p.seaZone !== null &&
      state.provinceController[p.id] === nation &&
      state.provinceOwner[p.id] === nation,
  );
  if (found === undefined) throw new Error(`nation ${nation} has no coast`);
  return found.id;
}

/** A fleet at full strength, put straight into the state. */
function fleet(
  state: WorldState,
  nation: number,
  base: number,
  template: FormationTemplate,
  zone: number | null,
  mission: Mission | null,
): Formation {
  const equipment = new Array<number>(10).fill(0);
  for (const [type, wanted] of Object.entries(FORMATIONS[template].equipment)) {
    equipment[equipmentIndex(type as never)] = wanted ?? 0;
  }
  const formation: Formation = {
    id: state.nations[nation].nextFormationId++,
    template,
    base,
    zone,
    mission,
    equipment,
  };
  state.nations[nation].formations.push(formation);
  return formation;
}

/** A division holding a full template, put straight into the state. */
function division(
  state: WorldState,
  nation: number,
  province: number,
): Division {
  const raised: Division = {
    id: state.nations[nation].nextDivisionId++,
    province,
    equipment: new Array<number>(10).fill(0),
  };
  raised.equipment[equipmentIndex("infantry_equipment")] = 100;
  raised.equipment[equipmentIndex("artillery")] = 12;
  state.nations[nation].divisions.push(raised);
  return raised;
}

describe("the sea half of phase 9", () => {
  let state: WorldState;
  let world: World;
  /** West-island source port (nation 1) and east-island beachhead port. */
  let home: number;
  let beachhead: number;

  beforeEach(() => {
    ({ world, state } = build());
    home = coastalOf(state, 1);
    setBuilding(state, home, "supply_hub", 1);
    setBuilding(state, home, "naval_base", 1);
    // A beachhead: nation 1 *controls* an east-island coastal province it
    // does not own, with a port — §6.6's "port on both ends".
    beachhead = coastalOf(state, 2);
    state.provinceController[beachhead] = 1;
    setBuilding(state, beachhead, "naval_base", 1);
    state.nations[1].stockpile[equipmentIndex("convoy")] = 200;
  });

  test("a port across the water is supplied over the sea", () => {
    const reach = supplyReach(state, 1);
    const supplied = reach.get(beachhead) ?? 0;
    expect(supplied).toBeGreaterThan(0.5);

    // The route the reach came from is the one the naval system will read:
    // one answer, computed one way.
    const routes = seaSupplyRoutes(state, 1);
    expect(routes.map((route) => route.province)).toContain(beachhead);
  });

  test("no port at the far end means no sea supply — §6.6's rule, not a bug", () => {
    setBuilding(state, beachhead, "naval_base", 0);
    const reach = supplyReach(state, 1);
    expect(reach.get(beachhead) ?? 0).toBe(0);
  });

  test("no convoys is badly supplied, never cut off", () => {
    const full = supplyReach(state, 1).get(beachhead) ?? 0;
    state.nations[1].stockpile[equipmentIndex("convoy")] = 0;
    const empty = supplyReach(state, 1).get(beachhead) ?? 0;
    expect(empty).toBeLessThan(full);
    expect(empty).toBeGreaterThan(0);
    // Exactly the floor's share of the convoyed reach: degrade, by the
    // constant that says how far (invariant 2).
    expect(empty / full).toBeCloseTo(SEA_SUPPLY_FLOOR, 10);
  });

  test("raiders over the route cut what gets through; escorts win part back", () => {
    const zone = state.map.provinces[beachhead].seaZone as number;
    const clean = supplyReach(state, 1).get(beachhead) ?? 0;

    const enemyPort = coastalOf(state, 2);
    fleet(state, 2, enemyPort, "submarine_flotilla", zone, "convoy_raiding");
    const raided = supplyReach(state, 1).get(beachhead) ?? 0;
    expect(raided).toBeLessThan(clean);
    expect(raided).toBeGreaterThan(0);

    fleet(state, 1, home, "escort_group", zone, "convoy_escort");
    const escorted = supplyReach(state, 1).get(beachhead) ?? 0;
    expect(escorted).toBeGreaterThan(raided);
    expect(escorted).toBeLessThanOrEqual(clean);
  });

  test("raiding sinks convoys — but only where there is traffic", () => {
    const zone = state.map.provinces[beachhead].seaZone as number;
    const enemyPort = coastalOf(state, 2);
    fleet(state, 2, enemyPort, "submarine_flotilla", zone, "convoy_raiding");

    const sunk = navalSystem
      .run(state, 1)
      .filter(
        (event) => event.kind === "stockpile_changed" && event.nation === 1,
      );
    expect(sunk.length).toBe(1);
    const delta = (sunk[0] as { delta: [number, number][] }).delta;
    expect(delta[0][0]).toBe(equipmentIndex("convoy"));
    expect(delta[0][1]).toBeLessThan(0);

    // Take the traffic away — no route, no exposure, no sinking. A warehouse
    // is not a target; ships at sea are.
    setBuilding(state, beachhead, "naval_base", 0);
    const quiet = navalSystem
      .run(state, 1)
      .filter(
        (event) => event.kind === "stockpile_changed" && event.nation === 1,
      );
    expect(quiet.length).toBe(0);
  });

  test("a contested sea costs both fleets equipment; an empty one is free", () => {
    const zone = state.map.provinces[beachhead].seaZone as number;
    const ours = fleet(state, 1, home, "battle_fleet", zone, "sea_control");
    const alone = navalSystem
      .run(state, 1)
      .filter((event) => event.kind === "formation_equipment_changed");
    expect(alone.length).toBe(0);

    const enemyPort = coastalOf(state, 2);
    const theirs = fleet(
      state,
      2,
      enemyPort,
      "battle_fleet",
      zone,
      "sea_control",
    );
    const contested = navalSystem
      .run(state, 1)
      .filter((event) => event.kind === "formation_equipment_changed");
    expect(
      contested.map((e) => (e as { nation: number }).nation).sort(),
    ).toEqual([1, 2]);
    void ours;
    void theirs;
  });

  test("a fleet whose harbour falls stands down rather than fighting on", () => {
    const zone = state.map.provinces[beachhead].seaZone as number;
    const ours = fleet(state, 1, home, "battle_fleet", zone, "sea_control");
    state.provinceController[home] = 2;
    const events = navalSystem
      .run(state, 1)
      .filter((event) => event.kind === "formation_assigned");
    expect(events).toContainEqual({
      kind: "formation_assigned",
      nation: 1,
      formationId: ours.id,
      zone: null,
      mission: null,
    });
  });

  test("an island nation can be offered a trade across the sea", () => {
    // Without the beachhead: a foothold on the partner's island is a *land*
    // route — the BFS starts from every controlled province — and these two
    // tests are about the sea.
    state.provinceController[beachhead] = 2;
    // Pre-phase-9 this was refused: "no land route ... which is phase 9".
    expect(
      world.rejectionFor({
        nation: 1,
        body: {
          kind: "propose_agreement",
          to: 2,
          type: "trade",
          terms: {
            resource: "steel",
            resourcePerTick: 0.5,
            pointsPerTick: 0.25,
          },
        },
      }),
    ).toBeNull();
    const route = tradeRouteBetween(state, 1, 2);
    expect(route.kind).toBe("sea");
    if (route.kind === "sea") expect(route.zones).toBeGreaterThanOrEqual(1);
  });

  test("an invasion is refused where §6.8 says it must be", () => {
    state.provinceController[beachhead] = 2;
    const troops = division(state, 1, home);

    // A garrisoned shore is not an open beach.
    const defender = division(state, 2, beachhead);
    expect(
      world.rejectionFor({
        nation: 1,
        body: {
          kind: "naval_invade",
          divisionId: troops.id,
          provinceId: beachhead,
        },
      }),
    ).toMatch(/garrisoned/);
    state.nations[2].divisions.pop();
    void defender;

    // An open one is an order the world takes.
    expect(
      world.rejectionFor({
        nation: 1,
        body: {
          kind: "naval_invade",
          divisionId: troops.id,
          provinceId: beachhead,
        },
      }),
    ).toBeNull();

    // A hostile sea gates it (§6.8: sea control). The enemy owns the target
    // zone outright, so our control there is the floor, not a stalemate.
    const zone = state.map.provinces[beachhead].seaZone as number;
    fleet(state, 2, coastalOf(state, 2), "battle_fleet", zone, "sea_control");
    expect(
      world.rejectionFor({
        nation: 1,
        body: {
          kind: "naval_invade",
          divisionId: troops.id,
          provinceId: beachhead,
        },
      }),
    ).toMatch(/sea zone/);
  });

  test("an invasion crosses over ticks, visibly, and takes an open beach", () => {
    state.provinceController[beachhead] = 2;
    const troops = division(state, 1, home);
    const before = [...troops.equipment];

    world.queueCommand({
      nation: 1,
      body: {
        kind: "naval_invade",
        divisionId: troops.id,
        provinceId: beachhead,
      },
    });
    world.step();

    // At sea: the transit exists, priced per zone crossed, and the division
    // is on the water rather than in any province. One tick of the crossing
    // is already spent — commands apply before the systems run, so the tick
    // that launches an invasion is also its first tick under way.
    const transit = state.nations[1].seaTransits[0];
    expect(transit).toBeDefined();
    expect(transit.ticksLeft).toBe(
      (transit.path.length - 1) * INVASION_TICKS_PER_ZONE - 1,
    );
    expect(troops.province).toBe(AT_SEA);
    // And everyone can see it coming — that is the §6.8 defence.
    expect(world.invasionsView()).toContainEqual({
      attacker: 1,
      to: beachhead,
      ticksLeft: transit.ticksLeft,
    });

    // The crossing itself already cost something: a division at sea is
    // beyond every supply line, and attrition is the §6.8 vulnerability.
    const rifles = equipmentIndex("infantry_equipment");
    expect(troops.equipment[rifles]).toBeLessThan(before[rifles]);
    const embarked = [...troops.equipment];

    // Fast-forward to the last tick, then the landing.
    transit.ticksLeft = 1;
    for (const event of navalSystem.run(state, 1)) applyEvent(state, event);

    expect(state.nations[1].seaTransits).toHaveLength(0);
    expect(troops.province).toBe(beachhead);
    expect(state.provinceController[beachhead]).toBe(1);
    // §6.8: it lands at reduced strength — the surf's share, on top of what
    // the crossing already took.
    expect(troops.equipment[rifles]).toBeCloseTo(
      embarked[rifles] * INVASION_LANDING_FACTOR,
      6,
    );
  });

  test("a garrison raised during the crossing turns the landing back", () => {
    state.provinceController[beachhead] = 2;
    const troops = division(state, 1, home);
    world.queueCommand({
      nation: 1,
      body: {
        kind: "naval_invade",
        divisionId: troops.id,
        provinceId: beachhead,
      },
    });
    world.step();

    // The defender watched the transit and answered it.
    division(state, 2, beachhead);
    const transit = state.nations[1].seaTransits[0];
    transit.ticksLeft = 1;
    for (const event of navalSystem.run(state, 1)) applyEvent(state, event);

    expect(state.nations[1].seaTransits).toHaveLength(0);
    expect(troops.province).toBe(home);
    expect(state.provinceController[beachhead]).toBe(2);
  });

  test("a sea trade's traffic alone is exposure enough for the raiders", () => {
    // No beachhead, no sea supply route — the only ships on the water are
    // the trade's. The exposure has to be priced like the trade system
    // prices the route (CONVOYS_PER_TRADE_FLOW_ZONE × rate × zones-or-one):
    // the first gate run priced it at `zones × rate` with zones 0, and the
    // raiders sank exactly nothing while the check credited wear as war.
    state.provinceController[beachhead] = 2;
    setBuilding(state, beachhead, "naval_base", 0);
    state.agreements.push({
      id: 1,
      type: "trade",
      parties: [2, 1],
      terms: { resource: "steel", resourcePerTick: 0.5, pointsPerTick: 0.25 },
      accepted: true,
      noticeAt: null,
      noticeBy: null,
    });
    state.nations[2].resources.steel = 100;
    const capital = state.map.provinces.find(
      (p) => p.capital && state.provinceController[p.id] === 1,
    ) as { id: number };
    setBuilding(state, capital.id, "civilian_factory", 4);

    const zone = state.map.provinces[beachhead].seaZone as number;
    fleet(
      state,
      2,
      coastalOf(state, 2),
      "submarine_flotilla",
      zone,
      "convoy_raiding",
    );

    const sunk = navalSystem
      .run(state, 1)
      .filter(
        (event) => event.kind === "stockpile_changed" && event.nation === 1,
      );
    expect(sunk.length).toBe(1);
    const [index, delta] = (sunk[0] as { delta: [number, number][] }).delta[0];
    expect(index).toBe(equipmentIndex("convoy"));
    // The magnitude is the regression: under the zones-times-rate pricing
    // this read about -0.003 a tick and drowned in the wear.
    expect(delta).toBeLessThan(-0.01);
  });

  test("a seaborne trade moves on convoys, and without them it does not", () => {
    state.provinceController[beachhead] = 2;
    // Nation 2 sells steel to nation 1 over the strait; nation 1, the
    // importer, finds the ships.
    state.agreements.push({
      id: 1,
      type: "trade",
      parties: [2, 1],
      terms: { resource: "steel", resourcePerTick: 0.5, pointsPerTick: 0.25 },
      accepted: true,
      noticeAt: null,
      noticeBy: null,
    });
    state.nations[2].resources.steel = 100;
    // The buyer needs points to pay with: civilian factories at its capital.
    const capital = state.map.provinces.find(
      (p) => p.capital && state.provinceController[p.id] === 1,
    );
    expect(capital).toBeDefined();
    setBuilding(state, (capital as { id: number }).id, "civilian_factory", 4);

    const carried = nationTrade(state, 1);
    expect(carried.resourceIn.steel).toBeGreaterThan(0);

    state.nations[1].stockpile[equipmentIndex("convoy")] = 0;
    const stranded = nationTrade(state, 1);
    expect(stranded.resourceIn.steel).toBe(0);
  });
});
