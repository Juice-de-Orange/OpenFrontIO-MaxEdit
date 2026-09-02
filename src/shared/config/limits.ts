/**
 * The ceilings on what a nation may hold, in one place.
 *
 * They were module-private constants in `World.ts`, where the command path
 * enforces them. The regent (`systems/regent/`) emits events directly and
 * bypasses that path, so it has to respect the same ceilings itself — and a
 * ceiling two files agree on has to live somewhere both can read.
 */

/** A queue nobody could work through is a queue used as a memory leak. */
export const MAX_QUEUE_LENGTH = 24;

/** And the same reasoning for the other two lists a command can grow. */
export const MAX_PRODUCTION_LINES = 12;
export const MAX_DIVISIONS = 200;
/** Wings and fleets share one list and one ceiling (§6.7, §6.8). */
export const MAX_FORMATIONS = 60;

/**
 * And for agreements, proposals included.
 *
 * Proposals are what makes a limit necessary at all: an agreement needs two
 * nations to want it, but an offer needs only one, and a client in a loop
 * could otherwise fill the world with them.
 */
export const MAX_AGREEMENTS = 24;
