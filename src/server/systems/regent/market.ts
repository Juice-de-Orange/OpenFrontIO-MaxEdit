/**
 * The market, up to the budget — the regent's only economic reaction
 * (§6.10, invariant 7: an order at the market is not an obligation). A
 * shortage buys the scarcest resource; a healthy economy clears the order
 * rather than paying the market's rates for ever.
 */

import { RESOURCES } from "src/shared/config/provinces";
import type { WorldEvent } from "../../world/WorldState";
import type { Situation } from "./situation";

export function market(s: Situation): WorldEvent[] {
  const { me, nation } = s;
  const events: WorldEvent[] = [];
  if (s.economy.sufficiency < 1) {
    if (s.scarcest !== null && me.regent.marketBudget > 0) {
      const wanted = Math.min(
        me.regent.marketBudget,
        s.economy.demand[s.scarcest],
      );
      if (me.market[s.scarcest] !== wanted) {
        events.push({
          kind: "market_order_set",
          nation,
          resource: s.scarcest,
          perTick: wanted,
        });
      }
    }
    return events;
  }
  for (const resource of RESOURCES) {
    if (me.market[resource] > 0) {
      events.push({ kind: "market_order_set", nation, resource, perTick: 0 });
    }
  }
  return events;
}
