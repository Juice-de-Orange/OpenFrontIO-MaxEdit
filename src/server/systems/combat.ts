/**
 * The front: standing attacks, resolved every tick.
 *
 * CLAUDE.md §6.9, and it is **front-based, not unit-based**. A player orders an
 * attack on a province (`claim_province`) and the order stands. Every tick this
 * system asks the same question of every standing order — can the force that
 * can reach this border beat what is holding it, this tick, with this roll —
 * and answers it in equipment on both sides. The order grinds until the
 * province falls or the player calls it off.
 *
 * The inputs are §6.9's own: equipment (a division's strength), supply, terrain,
 * combat width, air superiority over the province's zone, and a roll seeded
 * from `(worldSeed, tick, province)` so the tick stays reproducible from the
 * log (§9).
 *
 * **The border drift is gone.** From phase 1 to phase 7 this system was a
 * deterministic sweep that moved one province a tick regardless of who held
 * what, so that a world with nobody online still looked alive. It was a
 * placeholder for a nation nobody is playing doing something, which is exactly
 * what the regent is for (§6.10, phase 10) — and leaving it beside a real
 * resolver would have meant two ways to take a province, the cheaper of which
 * ignored terrain, supply and everything else this file is about. Between here
 * and phase 10 an unattended world is quiet, and that is honest: there is
 * nobody there to attack.
 */

import { GROUND_SUPPORT_SWING } from "src/shared/config/air";
import {
  ATTACKER_LOSS,
  COMBAT_LUCK,
  COMBAT_SUPPLY_FLOOR,
  COMBAT_WIDTH,
  DEFENDER_LOSS,
  TERRAIN_DEFENCE,
} from "src/shared/config/combat";
import { PseudoRandom } from "src/shared/util/PseudoRandom";
import type { System } from ".";
import {
  atPeace,
  divisionStrength,
  nationModifiers,
  type Division,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";
import { supplyCoverage, supplyOf, supplyReach } from "./supply";
import { missionEffect } from "./zones";

/**
 * What a division brings to a fight.
 *
 * Its equipment, scaled by how much of its supply is getting through — and not
 * to nothing: §6.6 already takes an unsupplied division's equipment away, and
 * taking its strength as well would punish the same shortage twice. Degrade,
 * never block.
 */
function strengthOf(division: Division, supply: number): number {
  const supplied = COMBAT_SUPPLY_FLOOR + (1 - COMBAT_SUPPLY_FLOOR) * supply;
  return divisionStrength(division) * supplied;
}

/**
 * The strongest `COMBAT_WIDTH` divisions a nation has in a province.
 *
 * §6.9 asks for combat width by name, and this is what it buys: a twentieth
 * division at a border adds nothing this tick. Strength above the width is not
 * destroyed — it is simply not in the fight, and it is there tomorrow.
 */
function engaged(
  state: WorldState,
  nation: number,
  province: number,
  supply: (province: number) => number,
): { strength: number; divisions: Division[] } {
  if (nation <= 0 || nation > state.nationCount) {
    return { strength: 0, divisions: [] };
  }
  const here = state.nations[nation].divisions.filter(
    (division) => division.province === province,
  );
  const ranked = here
    .map((division) => ({
      division,
      strength: strengthOf(division, supply(division.province)),
    }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, COMBAT_WIDTH);
  return {
    strength: ranked.reduce((sum, entry) => sum + entry.strength, 0),
    divisions: ranked.map((entry) => entry.division),
  };
}

/** Equipment destroyed in a set of divisions, as a share of what each holds. */
function losses(
  nation: number,
  divisions: Division[],
  fraction: number,
): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (const division of divisions) {
    const delta: [number, number][] = [];
    for (let index = 0; index < division.equipment.length; index++) {
      const held = division.equipment[index];
      if (held <= 0) continue;
      delta.push([index, -Math.min(held, held * fraction)]);
    }
    if (delta.length === 0) continue;
    events.push({
      kind: "division_equipment_changed",
      nation,
      divisionId: division.id,
      delta,
    });
  }
  return events;
}

export const combatSystem: System = {
  name: "combat",

  run(state: WorldState, tick: number): WorldEvent[] {
    const events: WorldEvent[] = [];
    // One supply solution per nation per tick rather than one per attack: the
    // reach is a search over the nation's provinces and several orders along
    // the same front would repeat it for the same answer.
    const supplies = new Map<number, (province: number) => number>();
    const supplyFor = (nation: number): ((province: number) => number) => {
      const known = supplies.get(nation);
      if (known !== undefined) return known;
      const reach = supplyReach(state, nation);
      const coverage = supplyCoverage(state, nation);
      const fn = (province: number): number =>
        supplyOf(reach, coverage, province);
      supplies.set(nation, fn);
      return fn;
    };

    for (let nation = 1; nation <= state.nationCount; nation++) {
      for (const attack of state.nations[nation].attacks) {
        const province = attack.province;
        const defender = state.provinceController[province];

        // Already theirs, by conquest or by treaty or by somebody else's war.
        // The order has nothing left to do and goes quietly.
        if (defender === nation) {
          events.push({ kind: "attack_ended", nation, province });
          continue;
        }

        // **Peace calls the attack off.** §6.9 refuses the order against a
        // nation you have promised not to attack, but an order given before
        // the promise would otherwise go on grinding — the pact would be
        // signed and the war would continue, which is the promise being worth
        // nothing in the only place it matters. Signing is a deliberate act
        // with a price attached, so ending the attack is the player's own
        // decision arriving a moment later, not something done behind them.
        if (defender > 0 && atPeace(state, nation, defender)) {
          events.push({ kind: "attack_ended", nation, province });
          continue;
        }

        // The attack comes out of the provinces the nation holds around it.
        // Nothing adjacent means nothing to attack with, and the order simply
        // waits — it is not an error and it is not cancelled, because the
        // ground may be retaken.
        const staging = state.map.provinces[province].neighbours.filter(
          (neighbour) => state.provinceController[neighbour] === nation,
        );
        if (staging.length === 0) continue;

        const supply = supplyFor(nation);
        let attacker = { strength: 0, divisions: [] as Division[] };
        for (const from of staging) {
          const force = engaged(state, nation, from, supply);
          if (force.strength > attacker.strength) attacker = force;
        }

        const holding = engaged(
          state,
          defender,
          province,
          supplyFor(defender > 0 ? defender : nation),
        );
        // **Nobody is holding it, so it is walked into.** A province with no
        // division in it is not a battle, and making one out of it would mean
        // a nation could not take empty ground without an army — which is not
        // what §6.9 describes and would make `claim_province` useless as the
        // instrument the early phases built on. Terrain and the roll decide
        // only when there is someone there to decide against.
        const contested = holding.divisions.length > 0;
        const terrain = TERRAIN_DEFENCE[state.map.provinces[province].terrain];
        const defence = holding.strength * terrain;

        // **A seeded roll, never Math.random().** The tick has to be
        // reproducible from the command log, and this is the only place in the
        // simulation that wants chance at all (§9).
        const random = new PseudoRandom(
          (state.worldSeed ^ Math.imul(tick, 0x9e3779b1) ^ province) >>> 0,
        );
        const luck = 1 - COMBAT_LUCK + random.next() * 2 * COMBAT_LUCK;

        // **Air superiority, and this is the multiplier this file has been
        // holding a place for since §6.9 became real.** §6.7: a superiority
        // ratio modifies ground combat strength through `ground_support`.
        // Both sides' bombers count, against each other, so the term is what
        // one side has over the other rather than what it has: an air force
        // matched by the enemy's shifts nothing, which is the honest answer
        // and the one a player can reason about.
        //
        // It is bounded by `GROUND_SUPPORT_SWING` and it multiplies rather
        // than decides. Air never takes a province on its own — it makes an
        // attack that was close land, and one that was hopeless slightly less
        // hopeless (invariant 2).
        const zone = state.map.provinces[province].airZone;
        const support =
          missionEffect(state, zone, nation, "ground_support", "air") -
          (defender > 0 && defender <= state.nationCount
            ? missionEffect(state, zone, defender, "ground_support", "air")
            : 0);
        const air = 1 + GROUND_SUPPORT_SWING * support;
        const pressed = attacker.strength * luck * air;

        if (!contested || pressed > defence) {
          events.push({ kind: "control_changed", province, nation });
          events.push({ kind: "attack_ended", nation, province });
        }

        // Won or lost, the fight costs both sides. Only what was engaged pays:
        // the divisions that could not fit in the combat width were not there.
        const shelter =
          defender <= 0 || defender > state.nationCount
            ? 0
            : nationModifiers(state, defender).defenderLoss;
        events.push(
          ...losses(nation, attacker.divisions, ATTACKER_LOSS),
          ...losses(
            defender,
            holding.divisions,
            Math.max(0, DEFENDER_LOSS * (1 + shelter)),
          ),
        );
      }
    }

    return events;
  },
};
