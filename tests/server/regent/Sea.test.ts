import { beforeEach, describe, expect, test } from "vitest";
import { type WorldState } from "../../../src/server/world/WorldState";
import { equipmentIndex } from "../../../src/shared/economy/Equipment";
import { islandFixture } from "../../util/worldFixture";
import {
  buildWorld,
  capitalOf,
  islandWorld,
  landWorld,
  ofKind,
  queued,
  seedFor,
  setBuilding,
  situation,
  steward,
  visit,
} from "./fixture";

/** A coastal province a nation both owns and controls. */
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

/**
 * Give `nation` a beachhead on the other island, with a port at both ends:
 * §6.6's sea supply, and so a route its convoys cross.
 */
function beachhead(state: WorldState, nation: number, other: number): number {
  const home = coastalOf(state, nation);
  setBuilding(state, home, "supply_hub", 1);
  setBuilding(state, home, "naval_base", 1);
  const far = coastalOf(state, other);
  state.provinceController[far] = nation;
  setBuilding(state, far, "naval_base", 1);
  state.nations[nation].stockpile[equipmentIndex("ships")] = 200;
  return home;
}

/**
 * The sea rule: §6.10's escort duty word for word, and the temperament on
 * top of it.
 */
describe("the regent at sea", () => {
  let state: WorldState;

  beforeEach(() => {
    ({ state } = islandWorld());
    steward(state, 1);
  });

  test("an island builds a port before anything else", () => {
    // The dockyard went (decision 0032): what a coast needs is somewhere to
    // raise a fleet, and the ships come off the same factories as the rest.
    expect(situation(state, 1).sea.island).toBe(true);
    const first = queued(visit(state));
    expect(first).toHaveLength(1);
    expect(first[0].building).toBe("naval_base");
    expect(state.map.provinces[first[0].provinceId].seaZone).not.toBeNull();
  });

  test("a sea route means convoys and escorts on the slips", () => {
    const home = beachhead(state, 1, 2);
    setBuilding(state, home, "military_factory", 2);
    expect(situation(state, 1).sea.routes.length).toBeGreaterThan(0);
    expect(situation(state, 1).sea.convoysWanted).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) visit(state);
    const lines = state.nations[1].productionLines.map((l) => l.equipment);
    expect(lines).toContain("ships");
    expect(lines).toContain("ships");
  });

  test("the escort duty: a group on convoy_escort over a zone the convoys cross", () => {
    beachhead(state, 1, 2);
    state.nations[1].stockpile[equipmentIndex("ships")] = 100;
    const raised = ofKind(visit(state), "formation_raised");
    expect(raised.map((r) => r.template)).toContain("fleet");
    const group = state.nations[1].formations.find(
      (f) => f.template === "fleet",
    );
    if (group === undefined) throw new Error("no escort group");
    group.equipment[equipmentIndex("ships")] = 12;

    const sent = ofKind(visit(state), "formation_assigned").filter(
      (e) => e.formationId === group.id,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].mission).toBe("patrol");
    expect(situation(state, 1).sea.routeZones).toContain(sent[0].zone);
  });

  test("a hunter sends submarines against the enemy's routes", () => {
    // A seed that makes nation 1 a hunter at sea — and the enemy the one
    // with a route to raid: their beachhead on my island.
    const fixture = islandFixture();
    const seed = seedFor(fixture, 1, (t) => t.aggression * t.naval >= 0.4);
    ({ state } = buildWorld(fixture, seed));
    steward(state, 1);
    beachhead(state, 2, 1);
    setBuilding(state, coastalOf(state, 1), "naval_base", 1);
    state.nations[1].stockpile[equipmentIndex("ships")] = 100;
    expect(situation(state, 1).sea.enemySeaZones().length).toBeGreaterThan(0);

    const raised = ofKind(visit(state), "formation_raised");
    expect(raised.map((r) => r.template)).toContain("fleet");
    const flotilla = state.nations[1].formations.find(
      (f) => f.template === "fleet",
    );
    if (flotilla === undefined) throw new Error("no flotilla");
    flotilla.equipment[equipmentIndex("ships")] = 20;
    const sent = ofKind(visit(state), "formation_assigned").filter(
      (e) => e.formationId === flotilla.id,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].mission).toBe("raiding");
    expect(situation(state, 1).sea.enemySeaZones()).toContain(sent[0].zone);
  });

  test("a landlocked nation never touches the sea", () => {
    ({ state } = landWorld());
    steward(state, 1);
    expect(situation(state, 1).coastal).toBe(false);
    state.nations[1].stockpile[equipmentIndex("ships")] = 100;
    state.nations[1].stockpile[equipmentIndex("ships")] = 100;
    for (let i = 0; i < 10; i++) {
      const events = visit(state);
      for (const order of queued(events)) {
        expect(order.building).not.toBe("naval_base");
      }
      for (const line of ofKind(events, "production_line_created")) {
        expect(["ships", "ships", "ships", "ships"]).not.toContain(
          line.equipment,
        );
      }
      expect(ofKind(events, "formation_raised")).toHaveLength(0);
    }
    void capitalOf;
  });
});
