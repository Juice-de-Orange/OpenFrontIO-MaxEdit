/**
 * Diplomacy and trade: what an agreement is, and what breaking one costs.
 *
 * CLAUDE.md §6.5, and invariant 3 in particular — *every commitment is
 * indefinite, with a cost to break*. There are no durations in this file and
 * there is nothing anywhere in the system that expires. The one number here
 * measured in ticks is a **notice period**: how long after a cancellation the
 * flow actually stops, so that the other side hears about it before it feels
 * it. That is a courtesy, not an expiry, and it is the only place a duration
 * appears in §6.5 at all.
 *
 * The balancing lever is `TRUST_COST`. Duration is deliberately not one.
 */

import type { Resource } from "./provinces";
import { TICK_MS, TICKS_PER_DAY } from "./time";

/**
 * What two nations can agree to. All bilateral, all indefinite.
 *
 * - `non_aggression` — neither side may order an attack on the other.
 * - `trade` — a standing per-tick exchange: one side sends a resource, the
 *   other sends construction points back.
 * - `alliance` — non-aggression, plus transit rights, plus shared victory
 *   eligibility when there is a victory condition to share.
 * - `military_access` — transit rights without the rest.
 */
export const AGREEMENT_TYPES = [
  "non_aggression",
  "trade",
  "alliance",
  "military_access",
] as const;

export type AgreementType = (typeof AGREEMENT_TYPES)[number];

/** The agreement types under which an attack on the other side is refused. */
export const PEACE_AGREEMENTS: readonly AgreementType[] = [
  "non_aggression",
  "alliance",
];

/**
 * How long after notice is given the flow actually stops.
 *
 * One in-game day. §6.5: "Cancellation is always available and always takes
 * effect after a fixed notice period. The other side is notified immediately."
 * The notification is what this buys — a trade partner who wakes up to a
 * stopped flow and no warning cannot plan around it, and planning around each
 * other is the entire point of the system.
 */
export const AGREEMENT_NOTICE_TICKS = TICKS_PER_DAY;

/** Where a nation's trust starts. Nobody has broken anything yet. */
export const TRUST_START = 100;
export const TRUST_MIN = 0;
export const TRUST_MAX = 100;

/**
 * Trust regained per in-game day, back towards `TRUST_MAX`.
 *
 * **Zero is §6.5 read literally**: it says what breaking an agreement costs
 * and nothing about recovery, so nothing recovers. The open question since
 * phase 7 is whether that makes the first betrayal the last interesting
 * decision a nation makes. This constant is the answer's knob (decision
 * 0026, proposed): at 1 a broken non-aggression pact (75) takes 75 in-game
 * days — two and a half real weeks, nearly half a season — to live down.
 * At 0 the regrowth emits nothing at all, so a world on the default is the
 * world phase 7 gated.
 */
export const TRUST_REGROWTH_PER_DAY = 0;

/**
 * What cancelling each kind of agreement costs the canceller, in trust.
 *
 * The ordering is §6.5's own, and it is not the obvious one: "Cancelling a
 * trade agreement costs a little; cancelling an alliance costs a lot;
 * attacking a nation you hold a non_aggression with costs almost all of it."
 * Breaking a non-aggression pact is therefore the most expensive thing in the
 * game, above breaking an alliance — because there is only one reason to do
 * it, everyone can see what it is, and the pact is the thing that was standing
 * between them and a war.
 *
 * These are the numbers the whole system balances on and they are meant to be
 * retuned. Nothing else in §6.5 is a lever.
 */
export const TRUST_COST: Readonly<Record<AgreementType, number>> = {
  trade: 5,
  military_access: 10,
  alliance: 35,
  non_aggression: 75,
};

/**
 * How long a nation may be silent before its agreements dissolve by
 * themselves, at no cost to either side.
 *
 * §6.5's dead-partner rule exists so that indefinite agreements do not pile up
 * as dead weight across a six-week season, leaving a player with a web of
 * obligations to nations that stopped existing.
 *
 * **This is seven days of wall clock, and §6.5 says fourteen in-game days.**
 * Fourteen in-game days is 336 ticks, which at five seconds a tick is
 * twenty-eight real minutes — so a player who closed the tab over lunch would
 * come back to dissolved agreements. The sentence in §6.5 plainly means "has
 * stopped playing", and in this world's time scale that is days rather than
 * minutes. See docs/decisions/0012.
 *
 * Derived from `TICK_MS` rather than written out, so that it stays seven days
 * if the tick rate is ever retuned. Not from `WORLD_TICK_MS`: a gate running
 * a world a hundred times faster runs the same world sooner, not a different
 * one, and the schedule is anchored to the tick (decision 0003).
 *
 * "No sign of the player" is measured from the command log and nothing else
 * (§4): a session that connects writes a `nation_present` command, so being
 * there is a thing the log records and a replay can reconstruct. A connection
 * that is not in the log would make this rule un-replayable.
 */
const SILENT_REAL_DAYS = 7;
export const DEAD_PARTNER_TICKS = Math.round(
  (SILENT_REAL_DAYS * 24 * 60 * 60 * 1000) / TICK_MS,
);

/** How often a connected session says it is still there. */
export const PRESENCE_REFRESH_TICKS = 5 * TICKS_PER_DAY;

/**
 * The most one trade agreement may move per tick.
 *
 * A ceiling rather than a balance number: it stops a client proposing a rate
 * that would overflow the arithmetic or make the UI meaningless. A deposit
 * yields 0.05 a tick and a civilian factory makes 0.5 construction points, so
 * anything near these figures is already a very large agreement.
 */
export const MAX_TRADE_RESOURCE_PER_TICK = 5;
export const MAX_TRADE_POINTS_PER_TICK = 5;

/**
 * The world market's rates, in construction points per unit of resource.
 *
 * Deliberately unfavourable, and deliberately always available: §6.5 wants a
 * solo or isolated player to stay playable without diplomacy, not to be
 * comfortable. The spread between the two is the whole mechanism — buying
 * costs four times what selling earns — so a nation that trades with the
 * market instead of with a neighbour pays for the convenience every tick.
 *
 * Buying resources competes directly with building factories, because
 * construction points are the only currency there is (§6.5). That is what
 * makes the market a decision rather than a button.
 */
export const MARKET_BUY_POINTS: Readonly<Record<Resource, number>> = {
  steel: 4,
  oil: 6,
  aluminium: 5,
  rubber: 6,
};

export const MARKET_SELL_POINTS: Readonly<Record<Resource, number>> = {
  steel: 1,
  oil: 1.5,
  aluminium: 1.25,
  rubber: 1.5,
};

/** The most a nation may ask the market for per tick, in either direction. */
export const MAX_MARKET_PER_TICK = 5;
