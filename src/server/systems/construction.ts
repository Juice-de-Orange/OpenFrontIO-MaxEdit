/**
 * The construction queue: points in at the front, a building out the far end.
 *
 * Invariant 1 in its purest form — *everything is a rate, never a lump sum*.
 * Nothing here completes on the tick it is ordered, partial progress survives
 * everything including a server restart, and a player watching the queue sees
 * a number move every five seconds.
 *
 * Only the front item takes points (`CONSTRUCTION_PARALLEL_ITEMS`). Splitting
 * the flow across the whole queue is the obvious alternative and it makes
 * every project finish late; a queue that finishes its front item is a queue a
 * player can plan against.
 *
 * An order whose province has been lost **waits**. It does not fail, it does
 * not refund, and it does not quietly vanish: the province may be retaken, and
 * a queue that empties itself while a player is offline is a queue they cannot
 * trust. Nothing irreversible happens without the player (invariant 7).
 */

import {
  CONSTRUCTION_PARALLEL_ITEMS,
  INFRASTRUCTURE_CONSTRUCTION_BONUS,
} from "src/shared/config/rates";
import { BUILDINGS } from "src/shared/economy/Buildings";
import type { System } from ".";
import {
  effectiveInfrastructure,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";
import { measureNation } from "./economy";

export const constructionSystem: System = {
  name: "construction",

  run(state: WorldState): WorldEvent[] {
    const events: WorldEvent[] = [];

    for (let nation = 1; nation <= state.nationCount; nation++) {
      const queue = state.nations[nation].constructionQueue;
      if (queue.length === 0) continue;

      // Recomputed rather than handed down from the economy system, and safe
      // to recompute because construction points do not depend on resources —
      // civilian factories draw none. See measureNation.
      const points = measureNation(state, nation).construction;
      if (points <= 0) continue;

      let started = 0;
      for (let index = 0; index < queue.length; index++) {
        if (started >= CONSTRUCTION_PARALLEL_ITEMS) break;
        const order = queue[index];
        if (state.provinceController[order.provinceId] !== nation) continue;
        started++;

        const infrastructure = effectiveInfrastructure(state, order.provinceId);
        const rate =
          points * (1 + infrastructure * INFRASTRUCTURE_CONSTRUCTION_BONUS);
        const cost = BUILDINGS[order.building].cost;
        const remaining = cost - order.progress;

        if (rate < remaining) {
          events.push({
            kind: "construction_progressed",
            nation,
            index,
            points: rate,
          });
          continue;
        }

        // The tick it completes, it takes only what it still needed. The rest
        // is not carried to the next item: a queue that ran ahead of itself on
        // the last tick of a project would make the *next* project's first
        // tick look like a bug.
        events.push({
          kind: "construction_progressed",
          nation,
          index,
          points: remaining,
        });
        events.push({
          kind: "construction_finished",
          nation,
          index,
          province: order.provinceId,
          building: order.building,
        });
        // The finish event splices the order out, so every later index in this
        // nation's queue shifts. Emitting two of them in one tick would apply
        // the second to the wrong order — which is why only the front item is
        // ever worked on, and why that is enforced here rather than assumed.
        break;
      }
    }

    return events;
  },
};
