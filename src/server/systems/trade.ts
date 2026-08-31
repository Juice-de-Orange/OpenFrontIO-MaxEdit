/**
 * Standing agreements, and what flows along them every tick.
 *
 * CLAUDE.md §6.5, and this is where invariant 3 finally becomes code: *every
 * commitment is indefinite, with a cost to break*. Nothing in this file
 * expires. An agreement runs until somebody cancels it, and cancelling costs
 * trust rather than time.
 *
 * Three things happen here, in this order:
 *
 * 1. **Agreements that have run out of parties are dissolved** — the notice
 *    somebody gave a day ago, or the dead-partner rule. Both cost nothing;
 *    the cost was paid when the notice was given, and a nation that has gone
 *    away cannot be punished for it.
 * 2. **Trade flows move**, scaled down together when a side cannot cover its
 *    rate. Never refused, never broken (invariant 2): the number gets worse.
 * 3. **The world market fills whatever standing order a nation left with it**,
 *    at rates bad enough that anyone with a neighbour would rather deal with
 *    the neighbour.
 *
 * **Construction points are the currency, and there is no second one.** A
 * nation that imports steel is a nation building fewer factories this tick,
 * which is what gives trade a real price and is the reason §6.5 chose points
 * over inventing money. Points are a *flow* and not a stock — there is nowhere
 * to keep them — so the payment is made by the construction system taking less
 * (`constructionAvailable` below), not by anything in this file moving them.
 *
 * The scale a flow runs at is computed from the world by both systems rather
 * than handed from one to the other. They agree because the state they read
 * agrees, with one nuance worth naming: a civilian factory that *completes*
 * during the construction phase raises the nation's output between the two
 * calls, so on that one tick the trade may run a shade richer than the
 * construction that paid for it. One factory, one tick, in a factor that is
 * 1 for any nation not over-committed.
 */

import {
  AGREEMENT_NOTICE_TICKS,
  DEAD_PARTNER_TICKS,
  MARKET_BUY_POINTS,
  MARKET_SELL_POINTS,
} from "src/shared/config/diplomacy";
import type { Resource } from "src/shared/config/provinces";
import { RESOURCES } from "src/shared/config/provinces";
import { RESOURCE_CAP } from "src/shared/config/rates";
import type { System } from ".";
import {
  agreementIsLive,
  type Agreement,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";
import { measureNation } from "./economy";

/** What one nation's standing commitments move this tick, already scaled. */
export interface NationTrade {
  /** Construction points leaving: paid to trade partners and to the market. */
  pointsOut: number;
  /** Construction points arriving from partners, and from selling to the market. */
  pointsIn: number;
  /** Resource units leaving, per resource. */
  resourceOut: Record<Resource, number>;
  /** Resource units arriving, per resource. */
  resourceIn: Record<Resource, number>;
}

function zeroed(): Record<Resource, number> {
  return Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<
    Resource,
    number
  >;
}

/**
 * Everything one pass over the world needs to know, worked out once.
 *
 * Without this the arithmetic is quadratic in a way that does not show up in a
 * test and does show up in a tick: every share asked "which agreements are
 * live", every one of those asked "does this nation still hold a capital",
 * and that last question is a walk over five hundred provinces. Fifty-two
 * nations times a couple of dozen agreements times two systems, every tick.
 *
 * So the walk happens once, the live list is built once, and construction
 * points are measured at most once per nation. A caller that has no context
 * gets one built for it, which is right for the single-nation views and wrong
 * for a loop over all of them.
 */
export interface TradeContext {
  /** Trade agreements moving something this tick, in a stable order. */
  live: Agreement[];
  /** Nations that still hold a capital somewhere. */
  hasCapital: Set<number>;
  /** Construction points per nation, measured lazily and kept. */
  construction: Map<number, number>;
}

export function tradeContext(state: WorldState): TradeContext {
  const hasCapital = new Set<number>();
  for (const province of state.map.provinces) {
    if (!province.capital) continue;
    const holder = state.provinceController[province.id];
    if (holder > 0) hasCapital.add(holder);
  }
  const context: TradeContext = {
    live: [],
    hasCapital,
    construction: new Map(),
  };
  // **The dead-partner test is in the live list itself**, not only in the
  // dissolution below, and that is deliberate: the construction system reads
  // these same flows one system earlier in the tick and has to reach the same
  // answer. Left out, a nation would spend construction points on the tick its
  // partner died and receive nothing for them.
  context.live = state.agreements.filter(
    (agreement) =>
      agreement.type === "trade" &&
      agreement.terms !== null &&
      agreementIsLive(agreement, state.tick) &&
      !agreement.parties.some((party) => isDeadPartner(state, party, context)),
  );
  return context;
}

/** Construction points this nation makes this tick, measured at most once. */
function constructionOf(
  state: WorldState,
  nation: number,
  context: TradeContext,
): number {
  const known = context.construction.get(nation);
  if (known !== undefined) return known;
  const made = measureNation(state, nation).construction;
  context.construction.set(nation, made);
  return made;
}

/**
 * Construction points this nation has promised away this tick, unscaled.
 *
 * Everything it owes, before asking whether it can pay: partners it buys from,
 * and standing orders with the market.
 */
/**
 * What one agreement actually ships this tick, before anyone pays for it.
 *
 * Only the seller's side: how much of the promised resource is really there.
 * It is the first of three passes, and the only one that depends on nothing
 * but the world — which is what keeps the whole calculation free of a fixpoint.
 */
function deliveryScale(
  state: WorldState,
  agreement: Agreement,
  context: TradeContext,
): number {
  if (agreement.terms === null) return 0;
  return resourceShare(
    state,
    agreement.parties[0],
    agreement.terms.resource,
    context,
  );
}

/**
 * Construction points this nation owes this tick — **for what it is getting**.
 *
 * Scaled by what the seller can actually deliver, not by the rate on paper.
 * Counting the paper rate made a partner's shortfall into the buyer's problem
 * twice over: the buyer received less *and* its remaining points were rationed
 * against a bill it was never going to be sent, which quietly under-filled its
 * world-market order — in exactly the situation §6.5 built the market for.
 */
function pointsOwed(
  state: WorldState,
  nation: number,
  context: TradeContext,
): number {
  let owed = 0;
  for (const agreement of context.live) {
    if (agreement.parties[1] !== nation) continue;
    owed +=
      (agreement.terms?.pointsPerTick ?? 0) *
      deliveryScale(state, agreement, context);
  }
  for (const resource of RESOURCES) {
    const order = state.nations[nation].market[resource];
    if (order > 0) owed += order * MARKET_BUY_POINTS[resource];
  }
  return owed;
}

/**
 * Construction points coming *in*: what this nation's exports have earned.
 *
 * Counted against what it owes, because points are a flow and a nation that
 * sells steel for points can obviously spend them. Leaving this out made a
 * nation with no civilian factories unable to buy anything at all, however
 * much it was selling — a hard block, which is what invariant 2 forbids.
 *
 * Measured before the payers' own shortfalls are known, so it is what this
 * nation is *owed* rather than what it will be handed. A payer that cannot
 * cover its bill leaves the seller a shade over-committed for one tick;
 * `constructionAvailable` floors at zero and nothing can go negative.
 */
function pointsIncome(
  state: WorldState,
  nation: number,
  context: TradeContext,
): number {
  let income = 0;
  for (const agreement of context.live) {
    if (agreement.parties[0] !== nation) continue;
    income +=
      (agreement.terms?.pointsPerTick ?? 0) *
      deliveryScale(state, agreement, context);
  }
  for (const resource of RESOURCES) {
    const order = state.nations[nation].market[resource];
    if (order < 0) {
      income +=
        -order *
        resourceShare(state, nation, resource, context) *
        MARKET_SELL_POINTS[resource];
    }
  }
  return income;
}

/** The same for one resource: what it has promised to send out. */
function resourceOwed(
  state: WorldState,
  nation: number,
  resource: Resource,
  context: TradeContext,
): number {
  let owed = 0;
  for (const agreement of context.live) {
    if (agreement.parties[0] !== nation) continue;
    if (agreement.terms?.resource !== resource) continue;
    owed += agreement.terms.resourcePerTick;
  }
  const order = state.nations[nation].market[resource];
  if (order < 0) owed += -order;
  return owed;
}

/**
 * What is *arriving*, before the receiver's shelf space is considered.
 *
 * Needed because a stockpile has a ceiling and the reducer clamps at it. A
 * flow that overran the ceiling used to be thrown away by the clamp while the
 * buyer paid for it in full, every tick, for as long as the agreement stood —
 * and standing agreements are indefinite (invariant 3), so that state is one
 * the design walks into rather than an accident.
 */
function resourceIncoming(
  state: WorldState,
  nation: number,
  resource: Resource,
  context: TradeContext,
): number {
  let incoming = 0;
  for (const agreement of context.live) {
    if (agreement.parties[1] !== nation) continue;
    if (agreement.terms?.resource !== resource) continue;
    incoming +=
      agreement.terms.resourcePerTick *
      deliveryScale(state, agreement, context);
  }
  const order = state.nations[nation].market[resource];
  if (order > 0) incoming += order;
  return incoming;
}

/**
 * The share of its promises a nation can actually keep this tick, 0..1.
 *
 * One figure per nation for points and one per resource, so that a nation
 * short of steel scales every steel agreement it has by the same amount
 * rather than honouring whichever was signed first. Invariant 2, and the same
 * shape as the sufficiency figure the economy computes.
 */
function pointsShare(
  state: WorldState,
  nation: number,
  context: TradeContext,
): number {
  const owed = pointsOwed(state, nation, context);
  if (owed <= 0) return 1;
  const made =
    constructionOf(state, nation, context) +
    pointsIncome(state, nation, context);
  return Math.max(0, Math.min(1, made / owed));
}

function resourceShare(
  state: WorldState,
  nation: number,
  resource: Resource,
  context: TradeContext,
): number {
  const owed = resourceOwed(state, nation, resource, context);
  if (owed <= 0) return 1;
  const held = state.nations[nation].resources[resource];
  return Math.max(0, Math.min(1, held / owed));
}

/** How much of what is arriving there is still room for, 0..1. */
function intakeShare(
  state: WorldState,
  nation: number,
  resource: Resource,
  context: TradeContext,
): number {
  const incoming = resourceIncoming(state, nation, resource, context);
  if (incoming <= 0) return 1;
  const room = Math.max(
    0,
    RESOURCE_CAP - state.nations[nation].resources[resource],
  );
  return Math.max(0, Math.min(1, room / incoming));
}

/**
 * How much of one agreement runs this tick.
 *
 * The worst of three: what the seller has, what the buyer can pay for, and
 * what the buyer has room for. If any of them falls short the whole exchange
 * scales down together — a trade where one side delivered in full and the
 * other did not would be a transfer, not a trade, and one where the goods
 * arrive at a full warehouse and are paid for anyway is a tax.
 */
function scaleOf(
  state: WorldState,
  agreement: Agreement,
  context: TradeContext,
): number {
  if (agreement.terms === null) return 0;
  return Math.min(
    deliveryScale(state, agreement, context),
    pointsShare(state, agreement.parties[1], context),
    intakeShare(state, agreement.parties[1], agreement.terms.resource, context),
  );
}

/** Everything one nation's standing commitments move this tick. */
export function nationTrade(
  state: WorldState,
  nation: number,
  context: TradeContext = tradeContext(state),
): NationTrade {
  const flow: NationTrade = {
    pointsOut: 0,
    pointsIn: 0,
    resourceOut: zeroed(),
    resourceIn: zeroed(),
  };

  for (const agreement of context.live) {
    if (agreement.terms === null) continue;
    const [seller, buyer] = agreement.parties;
    if (seller !== nation && buyer !== nation) continue;
    const scale = scaleOf(state, agreement, context);
    if (scale <= 0) continue;
    const { resource, resourcePerTick, pointsPerTick } = agreement.terms;
    if (seller === nation) {
      flow.resourceOut[resource] += resourcePerTick * scale;
      flow.pointsIn += pointsPerTick * scale;
    } else {
      flow.resourceIn[resource] += resourcePerTick * scale;
      flow.pointsOut += pointsPerTick * scale;
    }
  }

  const buying = pointsShare(state, nation, context);
  for (const resource of RESOURCES) {
    const order = state.nations[nation].market[resource];
    if (order > 0) {
      // Room on the shelf as well as money in the bank: the market is not
      // allowed to bill for a delivery the stockpile cap will discard.
      const bought =
        order * Math.min(buying, intakeShare(state, nation, resource, context));
      flow.resourceIn[resource] += bought;
      flow.pointsOut += bought * MARKET_BUY_POINTS[resource];
    } else if (order < 0) {
      const sold = -order * resourceShare(state, nation, resource, context);
      flow.resourceOut[resource] += sold;
      flow.pointsIn += sold * MARKET_SELL_POINTS[resource];
    }
  }

  return flow;
}

/**
 * Construction points this nation actually has to build with this tick.
 *
 * What its civilian factories made, less what it is paying out for imports,
 * plus what its exports earned. **This is the price of trade** — importing
 * resources competes with building factories, directly and visibly, and it is
 * why §6.5 refuses to invent a currency.
 *
 * Never negative: a nation that has promised more than it makes pays what it
 * can (the flows are scaled by `pointsShare` for exactly this reason) and
 * builds nothing that tick. It is not refused anything and nothing breaks.
 */
export function constructionAvailable(
  state: WorldState,
  nation: number,
  context: TradeContext = tradeContext(state),
): number {
  const flow = nationTrade(state, nation, context);
  const made = constructionOf(state, nation, context);
  return Math.max(0, made - flow.pointsOut + flow.pointsIn);
}

/**
 * A partner an agreement should not outlive.
 *
 * §6.5: a nation that has lost its capital, or that nobody has played for
 * fourteen in-game days. Presence is read from `lastSeenTick`, which every
 * accepted command sets — including the one a session sends when it connects,
 * so that "somebody is playing this nation" lives in the command log and not
 * in the socket layer, and a replay reaches the same conclusion (§4).
 */
export function isDeadPartner(
  state: WorldState,
  nation: number,
  context: TradeContext = tradeContext(state),
): boolean {
  if (state.tick - state.nations[nation].lastSeenTick > DEAD_PARTNER_TICKS) {
    return true;
  }
  return !context.hasCapital.has(nation);
}

export const tradeSystem: System = {
  name: "trade",

  run(state: WorldState, tick: number): WorldEvent[] {
    const events: WorldEvent[] = [];
    const context = tradeContext(state);

    // 1. Whatever has run out of notice or out of partners. Neither costs
    //    anybody anything: a notice was paid for when it was given, and a
    //    nation that has gone away cannot be punished for going away.
    //
    //    Nothing below has to wait for these to be applied. An agreement
    //    whose notice expires this tick is already not live — `agreementIsLive`
    //    says so from the expiry tick onwards — and a dead partner is already
    //    filtered out of `liveTrades`. The event removes the record; it does
    //    not stop a flow that would otherwise have moved.
    for (const agreement of state.agreements) {
      const expired =
        agreement.noticeAt !== null &&
        tick >= agreement.noticeAt + AGREEMENT_NOTICE_TICKS;
      const orphaned = agreement.parties.some((party) =>
        isDeadPartner(state, party, context),
      );
      if (!expired && !orphaned) continue;
      events.push({ kind: "agreement_dissolved", agreementId: agreement.id });
    }

    // 2. The flows themselves, one event per nation so the resource arrives
    //    and departs in the same tick and neither side can be double-counted.
    for (let nation = 1; nation <= state.nationCount; nation++) {
      const flow = nationTrade(state, nation, context);
      const delta: Partial<Record<Resource, number>> = {};
      let moved = false;
      for (const resource of RESOURCES) {
        const change = flow.resourceIn[resource] - flow.resourceOut[resource];
        if (change === 0) continue;
        delta[resource] = change;
        moved = true;
      }
      if (moved) events.push({ kind: "resources_changed", nation, delta });
    }

    return events;
  },
};
