/**
 * The border clash, and what it costs.
 *
 * This is the world's heartbeat wearing its eventual uniform. Since phase 1 a
 * single province has changed hands at a border every tick, deterministically,
 * so that a persistent world with nobody online still looks alive and so that
 * the replay test has something hard to reproduce. Phase 4 makes it cost
 * something: the divisions on both sides of that border lose equipment, and
 * the equipment is gone — destroyed, not returned (§6.3).
 *
 * That closes the loop the whole phase is about. A fight empties divisions,
 * the divisions refill from the national stockpile, the stockpile empties, and
 * the factories that have to fill it again are the ones the player has been
 * choosing between all along. **Every hostile action has an economic
 * footprint** (invariant 6), and this is the smallest honest version of it.
 *
 * What is deliberately *not* here is §6.9's real resolution: no combat width,
 * no terrain, no air superiority, no seeded roll deciding who wins. The
 * province that changes hands is still picked by the same deterministic sweep
 * as before. Division strength is computed and published from this phase on,
 * and phase 9 is what consumes it. Building a half-resolver now would mean
 * throwing it away then.
 */

import {
  COMBAT_ATTACKER_LOSS,
  COMBAT_DEFENDER_LOSS,
} from "src/shared/config/rates";
import type { System } from ".";
import type { Division, WorldEvent, WorldState } from "../world/WorldState";

/** The stride the drift walks the province list with. Coprime with any count. */
const DRIFT_STRIDE = 7919;

export const combatSystem: System = {
  name: "combat",

  run(state: WorldState, tick: number): WorldEvent[] {
    const count = state.provinceOwner.length;
    if (count === 0) return [];

    // Deterministic sweep rather than a random pick: the tick has to be
    // reproducible from the log, which is what the restore depends on. No
    // Math.random() anywhere near world state — CLAUDE.md §9.
    const start = (tick * DRIFT_STRIDE) % count;
    for (let i = 0; i < count; i++) {
      const province = (start + i) % count;

      // Never touch a province something else already moved this tick. A
      // heartbeat that can undo a player's order in the tick it lands is
      // indistinguishable, from the player's side, from the order being lost.
      // `heldSince` is set by the reducer on every control change, so this is
      // exact and needs no separate record of the tick's commands — which the
      // system could not see anyway, now that it is a system.
      if (state.provinceHeldSince[province] === tick) continue;

      const defender = state.provinceController[province];
      const from = state.map.provinces[province].neighbours.find(
        (neighbour) =>
          state.provinceController[neighbour] !== defender &&
          state.provinceController[neighbour] !== 0,
      );
      if (from === undefined) continue;

      const attacker = state.provinceController[from];
      return [
        { kind: "control_changed", province, nation: attacker },
        ...losses(state, defender, province, COMBAT_DEFENDER_LOSS),
        ...losses(state, attacker, from, COMBAT_ATTACKER_LOSS),
      ];
    }
    return [];
  },
};

/**
 * Equipment destroyed in one province's divisions.
 *
 * A share of what each division is holding, so a full-strength division loses
 * more in absolute terms than a hollow one — and a hollow one is not driven
 * below zero. The equipment is destroyed rather than captured: §6.3 is
 * explicit that combat losses permanently remove it from the stockpile, and
 * a war that recycled its own materiel would have no economic footprint at
 * all.
 */
function losses(
  state: WorldState,
  nation: number,
  province: number,
  fraction: number,
): WorldEvent[] {
  if (nation <= 0 || nation > state.nationCount) return [];
  const events: WorldEvent[] = [];
  for (const division of state.nations[nation].divisions) {
    if (division.province !== province) continue;
    const delta = destroyed(division, fraction);
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

function destroyed(division: Division, fraction: number): [number, number][] {
  const delta: [number, number][] = [];
  for (let index = 0; index < division.equipment.length; index++) {
    const held = division.equipment[index];
    if (held <= 0) continue;
    delta.push([index, -Math.min(held, held * fraction)]);
  }
  return delta;
}
