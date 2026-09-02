/**
 * What a trade's terms move, read the same way by everyone.
 *
 * §10: a trade may carry equipment beside — or instead of — a resource. The
 * rate that matters to the sea is the *whole* rate, because convoys carry
 * crates and do not care what is in them: the trade system prices a route's
 * convoys off it, the naval system exposes exactly the same figure to the
 * raiders, and the regent's escort duty counts convoys the same way. One
 * function, so the three can never disagree again (the phase-9 gate once
 * found trade and naval pricing the same route two different ways).
 */

/** The shape both the state and the wire agree on; the rest is theirs. */
export interface TradeGoods {
  resourcePerTick: number;
  equipment?: { perTick: number } | undefined;
}

/** Units a tick the trade moves from the first party, resource and equipment alike. */
export function tradeFlowRate(terms: TradeGoods): number {
  return terms.resourcePerTick + (terms.equipment?.perTick ?? 0);
}
