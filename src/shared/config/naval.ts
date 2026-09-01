/**
 * The sea: fleet attrition, convoys, and the landing.
 *
 * §6.8 by way of decision 0015: the contest itself is resolved by the same
 * zone machine as the air war, so everything aircraft-shaped lives in
 * `config/air.ts` and everything here is what only ships have — convoys, the
 * routes they carry, and the invasion.
 *
 * §6's system order puts naval *after* supply on purpose: supply computes
 * demand, naval destroys the convoys carrying it, and the shortfall lands on
 * the following tick. That one-tick lag is intentional (see
 * `server/systems/index.ts`) and several constants here are written against
 * it.
 */

/**
 * What a tick in a contested sea zone costs a fleet, as a share of what it
 * holds. The same shape as `AIR_LOSS`: a base for being in the fight and a
 * swing for losing it.
 */
export const NAVAL_LOSS = 0.015;
export const NAVAL_LOSS_SWING = 0.03;

/** An uncontested sea is free to sail. Presence is not attrition. */
export const NAVAL_LOSS_UNCONTESTED = 0;

/**
 * How far sea supply reaches, in sea zones crossed.
 *
 * The sea analogue of `SUPPLY_RANGE`: a route across more zones than this
 * carries nothing. Europe has 35 sea zones, so eight is a long way — the
 * Atlantic seaboard to the eastern Mediterranean — without being everywhere.
 */
export const SEA_SUPPLY_RANGE = 8;

/**
 * Convoys a sea supply route wants, per division at its far end and per zone
 * it crosses — §6.6: consumption proportional to the demand carried and the
 * sea distance. A nation's whole convoy stock is set against the sum over
 * all its sea use; the shortfall scales every sea route down together
 * (invariant 2), never one route to nothing.
 */
export const CONVOYS_PER_DIVISION_ZONE = 2;

/**
 * Convoys a seaborne trade route wants, per unit of resource rate and per
 * zone crossed. The §6.5 coupling: a trade that crosses water is raidable
 * because these are the ships that carry it. The *importer* finds the
 * convoys — the resource is what is at sea, and it is sailing to them.
 */
export const CONVOYS_PER_TRADE_FLOW_ZONE = 8;

/**
 * What still gets through with no convoys at all.
 *
 * A province with no convoys is badly supplied, not cut off — fishing boats
 * and ferries are not a merchant marine, but they are not nothing either.
 * Invariant 2's floor for the sea path.
 */
export const SEA_SUPPLY_FLOOR = 0.25;

/**
 * The most that raiders over a route can cut what arrives, mirroring
 * `INTERDICTION_MAX`. The raid also *sinks* convoys (below), which is the
 * lasting half — this is the immediate one.
 */
export const SEA_RAID_SUPPLY_MAX = 0.25;

/**
 * The share of a nation's exposed convoys sunk per tick under a full raiding
 * effort. "Exposed" means the convoys a route actually has at sea in the
 * raided zone, so a nation with no traffic loses nothing however many
 * submarines are hunting.
 */
export const CONVOY_RAID_LOSS = 0.03;

/**
 * How much of the raiding a full escort effort in the same zone removes.
 * Escorts counter submarines (§6.8); this is where the counter lives.
 */
export const ESCORT_COVER = 0.8;

/**
 * Convoys worn out per tick per zone crossed, as a share of what the route
 * wants — the peacetime cost of a merchant marine. Small: wear is what makes
 * convoys a standing production line rather than a one-off purchase, not
 * what decides a war.
 */
export const CONVOY_WEAR = 0.001;

/**
 * Ticks an invasion convoy needs per sea zone crossed: half an in-game day.
 * Transit is the visible, vulnerable part of the operation and it must be
 * long enough for a defender who is watching to react.
 */
export const INVASION_TICKS_PER_ZONE = 12;

/**
 * The share of its equipment a division still holds when it wades ashore.
 * §6.8: it lands at reduced strength.
 */
export const INVASION_LANDING_FACTOR = 0.7;

/**
 * The sea-control share a nation needs in every zone an invasion crosses.
 * §6.8: `sea_control` gates naval invasion — half means "at least a
 * stalemate", so an uncontested sea is enough and a losing one is not.
 */
export const INVASION_MIN_CONTROL = 0.5;
