/**
 * Supply: the system that makes the war slow.
 *
 * §6.6 opens with why it exists — "without it, everything degenerates into
 * blitz clicking" — and every number here is aimed at that. A nation can push
 * a long way from its hubs; what it cannot do is push a long way and still
 * fight, because the divisions out at the end of the line quietly come apart.
 *
 * Per invariant 2 nothing here blocks. A province out of range is not
 * unreachable, it is badly supplied: the divisions in it are weaker and lose
 * equipment, which is a number that got worse rather than a wall.
 */

/**
 * How far a source reaches, in **weighted** hops.
 *
 * Not provinces: a hop across good infrastructure costs less than one, and a
 * hop through the mountains costs a full one. Six is deliberately short —
 * about two provinces beyond a nation's own depth on Europe — so that taking
 * ground faster than you can build hubs is felt within an in-game week.
 */
export const SUPPLY_RANGE = 6;

/** What one hop costs before infrastructure is taken into account. */
export const SUPPLY_HOP_COST = 1;

/**
 * How much each level of infrastructure shortens a hop.
 *
 * At level 10 a hop costs 40% of what it costs at level 0, which is the floor
 * below. Building infrastructure is therefore a way of projecting supply and
 * not only of building faster — the same lever doing two jobs, which is what
 * keeps the building list short.
 */
export const SUPPLY_INFRASTRUCTURE_RELIEF = 0.06;

/** However good the roads, a hop is still a hop. */
export const SUPPLY_MIN_HOP_COST = 0.4;

/** Supply one division draws. Flat for now; §6.6 wants it per equipment. */
export const SUPPLY_PER_DIVISION = 1;

/**
 * How many divisions one source can actually feed.
 *
 * The second half of the model, and the one that punishes a big army rather
 * than a far-flung one: range says where supply can go, throughput says how
 * much of it there is. A nation that raises twenty divisions behind one hub
 * has them all at half supply without an enemy anywhere near.
 */
export const SUPPLY_SOURCE_THROUGHPUT = 4;

/**
 * Share of its equipment an entirely unsupplied division loses per tick.
 *
 * Scaled by how short it is, so a division at 80% supply loses a fifth of
 * this. Small on purpose: a front that grinds down over in-game weeks is the
 * shape this game wants, and a division should never evaporate while a player
 * is asleep — it should be visibly worse when they wake up.
 */
export const SUPPLY_ATTRITION = 0.02;
