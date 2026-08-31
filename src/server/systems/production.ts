/**
 * Production lines turn industry into equipment, and units draw it out again.
 *
 * §6.2 and §6.3, and between them the mechanic the whole game's pace rests on:
 * **a line's efficiency climbs while it runs and is knocked back to the floor
 * whenever its equipment type changes.** A player who commits to producing one
 * thing for a long time massively out-produces one who reacts constantly. That
 * is the intended lesson and the reason this game is not fast paced.
 *
 * The reset lives in the reducer, not here — switching is a command, not
 * something a system decides. What this system does is the other half: it
 * climbs the ramp for every line that actually produced, and lets it decay for
 * every line left with no factories on it. Adding or removing factories never
 * touches the ramp; only the type does.
 *
 * **This is why the regent may never reassign an existing line** (§6.10). It
 * would destroy in one automated decision what the player spent days building,
 * and the rule belongs here, next to the thing it protects, rather than in
 * phase 10 next to the regent that has to obey it.
 */

import {
  DIVISION_REINFORCE_RATE,
  EFFICIENCY_DECAY,
  EFFICIENCY_GAIN,
} from "src/shared/config/rates";
import {
  DIVISION_TEMPLATE,
  EQUIPMENT,
  equipmentIndex,
  type EquipmentType,
} from "src/shared/economy/Equipment";
import { FORMATIONS } from "src/shared/economy/Formations";
import type { System } from ".";
import {
  efficiencyCapFor,
  factoryOutput,
  nationModifiers,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";
import { measureNation } from "./economy";

export const productionSystem: System = {
  name: "production",

  run(state: WorldState): WorldEvent[] {
    const events: WorldEvent[] = [];

    for (let nation = 1; nation <= state.nationCount; nation++) {
      const lines = state.nations[nation].productionLines;
      const divisions = state.nations[nation].divisions;
      if (lines.length === 0 && divisions.length === 0) continue;

      // The same sufficiency the economy system charged the nation for. A
      // shortage scales what the factories make, exactly as it scales
      // everything else (invariant 2) — it never stops a line.
      const { sufficiency } = measureNation(state, nation);
      const cap = efficiencyCapFor(state, nation);
      const produced = new Map<number, number>();

      for (const line of lines) {
        if (line.factories <= 0) {
          // Idle, not switched: it keeps its type and loses the ramp slowly.
          // A line briefly stripped to move factories elsewhere is not ruined;
          // one abandoned for a season does not keep what it earned.
          if (line.efficiency > 0) {
            events.push({
              kind: "production_efficiency_changed",
              nation,
              lineId: line.id,
              efficiency: line.efficiency - EFFICIENCY_DECAY,
            });
          }
          continue;
        }

        const spec = EQUIPMENT[line.equipment];
        const perFactory = factoryOutput(state, nation, spec.yard);
        const output =
          line.factories * perFactory * line.efficiency * sufficiency;
        if (output <= 0) continue;

        const index = equipmentIndex(line.equipment);
        produced.set(index, (produced.get(index) ?? 0) + output / spec.cost);

        if (line.efficiency < cap) {
          events.push({
            kind: "production_efficiency_changed",
            nation,
            lineId: line.id,
            efficiency: line.efficiency + EFFICIENCY_GAIN,
          });
        }
      }

      if (produced.size > 0) {
        events.push({
          kind: "stockpile_changed",
          nation,
          delta: [...produced.entries()].sort((a, b) => a[0] - b[0]),
        });
      }

      events.push(...reinforce(state, nation));
    }

    return events;
  },
};

/**
 * Divisions, wings and fleets draw what they are short of out of the stockpile.
 *
 * A fraction of the shortfall per tick rather than all of it, so a unit fills
 * quickly at first and then tails off — and so a thin stockpile is shared out
 * between several of them instead of being emptied by whichever one is asked
 * for first. Nothing is ever refused: a unit simply gets less, and is weaker
 * for it (§6.3, invariant 2).
 *
 * **One pass over both kinds**, against one copy of the stockpile. §6.3 gives
 * divisions and formations the same warehouse, and two passes would let the
 * first kind empty it before the second was asked — which today would be
 * invisible, because no template shares an equipment type with another, and
 * tomorrow would be a bug nobody could see coming. Deterministic in the order
 * they were raised.
 *
 * The draw is computed against the stockpile as it stood at the start of the
 * tick, and capped by it, so nothing can take more than there is.
 */
function reinforce(state: WorldState, nation: number): WorldEvent[] {
  const { divisions, formations } = state.nations[nation];
  if (divisions.length === 0 && formations.length === 0) return [];

  const available = [...state.nations[nation].stockpile];
  const rate =
    DIVISION_REINFORCE_RATE *
    (1 + nationModifiers(state, nation).reinforceRate);
  const events: WorldEvent[] = [];
  const takenTotal = new Map<number, number>();

  /** One unit's draw against `available`, as an equipment delta. */
  const draw = (
    held: number[],
    template: Partial<Record<EquipmentType, number>>,
  ): [number, number][] => {
    const delta: [number, number][] = [];
    for (const [type, wanted] of Object.entries(template)) {
      if (wanted === undefined || wanted <= 0) continue;
      const index = equipmentIndex(type as EquipmentType);
      const short = wanted - held[index];
      if (short <= 0) continue;

      const asked = Math.min(short, wanted * rate);
      const taken = Math.min(asked, available[index]);
      if (taken <= 0) continue;

      available[index] -= taken;
      takenTotal.set(index, (takenTotal.get(index) ?? 0) + taken);
      delta.push([index, taken]);
    }
    return delta;
  };

  for (const division of divisions) {
    const delta = draw(division.equipment, DIVISION_TEMPLATE);
    if (delta.length > 0) {
      events.push({
        kind: "division_equipment_changed",
        nation,
        divisionId: division.id,
        delta,
      });
    }
  }

  for (const formation of formations) {
    const delta = draw(
      formation.equipment,
      FORMATIONS[formation.template].equipment,
    );
    if (delta.length > 0) {
      events.push({
        kind: "formation_equipment_changed",
        nation,
        formationId: formation.id,
        delta,
      });
    }
  }

  if (takenTotal.size > 0) {
    events.push({
      kind: "stockpile_changed",
      nation,
      delta: [...takenTotal.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, amount]) => [index, -amount] as [number, number]),
    });
  }
  return events;
}
