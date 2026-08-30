/**
 * Time, in one place.
 *
 * CLAUDE.md §9: every balance number lives in shared/config/, never inline in
 * a system. These three are the first of them, and they are also the ones both
 * sides need to agree on — the client renders at the server's tick rate.
 */

/**
 * One tick of wall clock. One tick is one in-game hour, so a day is two
 * minutes of real time.
 *
 * This is a *resolution* choice, not a speed choice. How fast the world feels
 * is set by the per-tick production and construction rates, not by this
 * number (CLAUDE.md §4).
 */
export const TICK_MS = 5000;

/** Ticks per in-game day. The UI multiplies by this and labels "per day". */
export const TICKS_PER_DAY = 24;

/**
 * How often a full world snapshot is written.
 *
 * Five minutes of wall clock. Per-tick writes are not viable at 17,280 ticks
 * a day; the command log covers the gap, so the worst case on a hard crash is
 * this many ticks of *simulation* replayed, and zero player commands lost.
 */
export const SNAPSHOT_INTERVAL_TICKS = 60;
