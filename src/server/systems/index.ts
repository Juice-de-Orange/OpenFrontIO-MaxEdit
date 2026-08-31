/**
 * The systems, and the order they run in.
 *
 * CLAUDE.md §6 fixes the order, and the order encodes real dependencies rather
 * than taste. The whole list is here from the start, most of it empty: an
 * empty slot in the right place is worth more than a short list that has to be
 * reordered later, because reordering is how a dependency gets inverted
 * without anyone noticing.
 *
 * ```
 * economy → construction → production → research → trade → supply →
 * air → naval → combat → regent → victory
 * ```
 *
 * The two that are not obvious, from §6:
 *
 * - **Trade before supply**, because imported resources have to be in the
 *   stockpile before supply consumption is computed against it.
 * - **Naval after supply**, so convoy demand is known before raiding is
 *   applied to it. The shortfall lands on the following tick. That one-tick
 *   lag is intentional and must not be "fixed" — resolving it in-tick creates
 *   a circular dependency between supply and naval.
 */

import type { WorldEvent, WorldState } from "../world/WorldState";
import { combatSystem } from "./combat";
import { constructionSystem } from "./construction";
import { economySystem } from "./economy";
import { productionSystem } from "./production";
import { researchSystem } from "./research";
import { supplySystem } from "./supply";

/**
 * A system: reads the world, returns what should happen to it.
 *
 * CLAUDE.md §9: no I/O, no wall clock, no `Math.random()`. All randomness comes
 * from a seeded PRNG derived from `(worldSeed, tick, contextId)`. A system that
 * writes to `world` directly is a system whose effects are not in the event
 * log, and the event log is what a replay has to work from.
 */
export interface System {
  readonly name: string;
  run(world: WorldState, tick: number): WorldEvent[];
}

/** A system that exists to hold its place in the order. */
function planned(name: string): System {
  return { name, run: () => [] };
}

export const SYSTEMS: readonly System[] = [
  economySystem,
  constructionSystem,
  productionSystem,
  researchSystem,
  planned("trade"),
  supplySystem,
  planned("air"),
  planned("naval"),
  combatSystem,
  planned("regent"),
  planned("victory"),
];
