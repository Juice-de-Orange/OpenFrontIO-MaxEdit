/**
 * The regent: the world playing a nation nobody is playing.
 *
 * CLAUDE.md §6.10, and load-bearing rather than a convenience: with a
 * five-second tick the regent plays the majority of a nation's ticks, and if
 * it cannot hold a front, players do not come back. Rule-based, no search,
 * no planning, no learning; it runs every `REGENT_INTERVAL_TICKS`, not every
 * tick, and it emits the same events a player's commands would — which is
 * what keeps a replayed world identical to the run: the rules are pure
 * functions of the state, so the replay reaches the same conclusions.
 *
 * **The second pass (decision 0028).** The first regent held a capital and
 * nothing else. This one reads a `Situation` once per visit and applies
 * eight rules to it, each in its own file: garrison, build, production, air,
 * sea, war, research, market. What differs between two stewards is the
 * temperament the rules read — six axes drawn from the world seed — so the
 * fifty-one nations nobody plays are fifty-one opponents.
 *
 * **The one rule that matters most**: it never changes an existing
 * production line's equipment type. That would reset the efficiency ramp to
 * the floor (§6.2) and destroy in one decision what a player spent days
 * building. Idle factories only.
 *
 * Per invariant 7 it never proposes, accepts or cancels an agreement, never
 * abandons a capital, and never orders a naval invasion. Its one economic
 * reaction is the world market, up to `marketBudget` — and the offensive
 * order is §6.10's own text, not an exception.
 *
 * Every rule mirrors the validation `rejectionFor` applies to a player,
 * because the regent bypasses it: `tests/server/regent/Commands.test.ts`
 * translates every event it emits into the player's command and asks the
 * world whether it would have been accepted.
 */

import { REGENT_INTERVAL_TICKS } from "src/shared/config/regent";
import type { System } from "..";
import type { WorldEvent, WorldState } from "../../world/WorldState";
import { air } from "./air";
import { build } from "./build";
import { garrison } from "./garrison";
import { market } from "./market";
import { production } from "./production";
import { research } from "./research";
import { sea } from "./sea";
import { assess } from "./situation";
import { war } from "./war";

export const regentSystem: System = {
  name: "regent",

  run(state: WorldState, tick: number): WorldEvent[] {
    // Half an in-game day between thoughts (§6.10). A steward that reacts
    // faster than the world moves is micromanaging.
    if (tick % REGENT_INTERVAL_TICKS !== 0) return [];

    const events: WorldEvent[] = [];
    for (let nation = 1; nation <= state.nationCount; nation++) {
      if (!state.nations[nation].regent.enabled) continue;
      const situation = assess(state, nation, tick);
      if (situation.mine.length === 0) continue;
      // The order is the order of need. Each rule reads the state as it was
      // at the start of the visit and rations itself; the events apply after
      // the system, so nothing here sees what the rule before it decided.
      events.push(
        ...garrison(situation),
        ...war(situation),
        ...build(situation),
        ...production(situation),
        ...air(situation),
        ...sea(situation),
        ...research(situation),
        ...market(situation),
      );
    }
    return events;
  },
};
