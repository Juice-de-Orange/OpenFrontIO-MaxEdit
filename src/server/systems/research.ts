/**
 * Research: N slots, a flat list, and a modifier at the end of it.
 *
 * §6.4 is the shortest section in the specification and says twice that this
 * system is to stay the cheapest one in the plan. So there is no focus tree,
 * no doctrine tree, no cost in resources and no partial credit: a slot works
 * on one tech, one tick at a time, and when it has done the hours the tech
 * asks for, the nation has it for good.
 *
 * Progress accrues per tick rather than completing on a deadline (invariant
 * 1), which is why the wire can show a bar that moves and a day count that
 * falls. And nothing here blocks: a nation with no slots free simply is not
 * researching, which is a choice it made rather than a wall it hit.
 *
 * **What this system does not do is apply the modifiers.** Those are read
 * where the rate is read — `modifiersOf(nation.unlockedTechs)` in the economy,
 * production and combat systems — so that there is one source of truth and a
 * restored world cannot come back with a stale copy of it.
 */

import { TECHS } from "src/shared/config/techs";
import type { System } from ".";
import type { WorldEvent, WorldState } from "../world/WorldState";

export const researchSystem: System = {
  name: "research",

  run(state: WorldState): WorldEvent[] {
    const events: WorldEvent[] = [];

    for (let nation = 1; nation <= state.nationCount; nation++) {
      const slots = state.nations[nation].researchSlots;
      for (let slot = 0; slot < slots.length; slot++) {
        const tech = slots[slot].tech;
        if (tech === null) continue;

        // A slot working past the number of slots the nation still has — it
        // lost the tech that granted one, which cannot happen yet, or a
        // snapshot from a longer list — keeps working. Stopping it would throw
        // away work for a reason the player never sees.
        const done = slots[slot].progress + 1;
        if (done >= TECHS[tech].ticks) {
          events.push({ kind: "research_completed", nation, slot, tech });
        } else {
          events.push({
            kind: "research_progressed",
            nation,
            slot,
            delta: 1,
          });
        }
      }
    }

    return events;
  },
};
