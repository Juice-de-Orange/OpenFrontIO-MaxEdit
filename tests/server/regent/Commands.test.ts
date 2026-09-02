import { describe, expect, test } from "vitest";
import { regentSystem } from "../../../src/server/systems/regent";
import type { World, WorldCommand } from "../../../src/server/world/World";
import {
  applyEvent,
  type WorldEvent,
  type WorldState,
} from "../../../src/server/world/WorldState";
import { REGENT_INTERVAL_TICKS } from "../../../src/shared/config/regent";
import { equipmentIndex } from "../../../src/shared/economy/Equipment";
import { islandFixture } from "../../util/worldFixture";
import {
  buildWorld,
  capitalOf,
  fillArmy,
  finishQueue,
  formation,
  islandWorld,
  landWorld,
  seedFor,
  setBuilding,
  steward,
} from "./fixture";

/**
 * The test phase 10 never had. The regent emits events straight into the
 * world and so bypasses `rejectionFor`; every rule promises to mirror what
 * a player is held to. This translates each event into the player's
 * command and asks the world whether it would have taken it — on the state
 * as it is when the event lands, one after the other, exactly as commands
 * from a player arrive.
 */
function commandFor(event: WorldEvent): WorldCommand["body"] | null {
  switch (event.kind) {
    case "division_raised":
      return { kind: "raise_division", provinceId: event.province };
    case "construction_queued":
      return {
        kind: "queue_construction",
        provinceId: event.order.provinceId,
        building: event.order.building,
      };
    case "production_line_created":
      return { kind: "create_production_line", equipment: event.equipment };
    case "production_factories_assigned":
      return {
        kind: "assign_factories",
        lineId: event.lineId,
        factories: event.factories,
      };
    case "formation_raised":
      return {
        kind: "raise_formation",
        template: event.template,
        provinceId: event.base,
      };
    case "formation_assigned":
      return {
        kind: "assign_formation",
        formationId: event.formationId,
        zone: event.zone,
        mission: event.mission,
      };
    case "attack_ordered":
      return { kind: "claim_province", provinceId: event.province };
    case "attack_ended":
      return { kind: "cancel_attack", provinceId: event.province };
    case "research_started":
      return { kind: "start_research", slot: event.slot, tech: event.tech };
    case "market_order_set":
      return {
        kind: "set_market_order",
        resource: event.resource,
        perTick: event.perTick,
      };
    case "manpower_changed":
      // The price of a raise, paid by the same rule: not a command.
      return null;
    default:
      throw new Error(`the regent emitted ${event.kind}, which no rule may`);
  }
}

function crossCheck(world: World, state: WorldState, visits: number): number {
  let checked = 0;
  for (let i = 0; i < visits; i++) {
    const events = regentSystem.run(state, REGENT_INTERVAL_TICKS);
    for (const event of events) {
      const body = commandFor(event);
      if (body !== null) {
        const nation = (event as { nation: number }).nation;
        const why = world.rejectionFor({ nation, body });
        expect(why, `${JSON.stringify(body)} at visit ${i}`).toBeNull();
        checked++;
      }
      applyEvent(state, event);
    }
    // Between visits the world moves: divisions fill, buildings finish.
    for (let nation = 1; nation <= state.nationCount; nation++) {
      if (!state.nations[nation].regent.enabled) continue;
      fillArmy(state, nation);
      finishQueue(state, nation);
    }
  }
  return checked;
}

describe("every regent event is a command the world would accept", () => {
  test("on land, under every focus, for every nation", () => {
    const { world, state } = landWorld();
    for (let nation = 1; nation <= state.nationCount; nation++) {
      steward(
        state,
        nation,
        (["economy", "military", "defence", "expansion"] as const)[nation % 4],
      );
    }
    expect(crossCheck(world, state, 30)).toBeGreaterThan(100);
  });

  test("with a sky to defend and wings to fly", () => {
    const { world, state } = landWorld();
    steward(state, 1, "military");
    const capital = capitalOf(state, 1);
    const sky = state.map.provinces[capital].airZone;
    const theirs = capitalOf(state, 2);
    setBuilding(state, theirs, "air_base", 1);
    formation(state, 2, theirs, "fighter_wing", sky, "air_superiority");
    formation(state, 2, theirs, "bomber_wing", sky, "strategic_bombing");
    setBuilding(state, capital, "air_base", 1);
    setBuilding(state, capital, "military_factory", 4);
    state.nations[1].stockpile[equipmentIndex("fighter")] = 1000;
    state.nations[1].stockpile[equipmentIndex("bomber")] = 1000;
    expect(crossCheck(world, state, 20)).toBeGreaterThan(20);
  });

  test("at sea, with routes to escort and an enemy to hunt", () => {
    const fixture = islandFixture();
    const seed = seedFor(fixture, 1, (t) => t.aggression * t.naval >= 0.4);
    const { world, state } = buildWorld(fixture, seed);
    for (const nation of [1, 2]) {
      steward(state, nation, nation === 1 ? "expansion" : "defence");
      const home = state.map.provinces.find(
        (p) =>
          p.seaZone !== null &&
          state.provinceController[p.id] === nation &&
          state.provinceOwner[p.id] === nation,
      );
      if (home === undefined) throw new Error("no coast");
      setBuilding(state, home.id, "supply_hub", 1);
      setBuilding(state, home.id, "naval_base", 1);
      setBuilding(state, home.id, "dockyard", 3);
      const far = state.map.provinces.find(
        (p) =>
          p.seaZone !== null &&
          state.provinceController[p.id] === 3 - nation &&
          state.provinceOwner[p.id] === 3 - nation,
      );
      if (far === undefined) throw new Error("no far coast");
      state.provinceController[far.id] = nation;
      setBuilding(state, far.id, "naval_base", 1);
      for (const type of [
        "convoy",
        "escort",
        "submarine",
        "capital_ship",
      ] as const) {
        state.nations[nation].stockpile[equipmentIndex(type)] = 1000;
      }
    }
    expect(crossCheck(world, state, 20)).toBeGreaterThan(20);
  });

  test("on the plain island, from nothing", () => {
    const { world, state } = islandWorld();
    steward(state, 1);
    steward(state, 2);
    expect(crossCheck(world, state, 20)).toBeGreaterThan(10);
  });
});
