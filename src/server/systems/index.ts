/**
 * The systems, and the order they run in.
 *
 * CLAUDE.md §6 fixes the order, and the order encodes real dependencies rather
 * than taste. The list was here from the start, most of it as empty slots —
 * an empty slot in the right place being worth more than a short list that
 * has to be reordered later — and as of the victory system every slot is a
 * real system. The `planned()` placeholder that held them is gone with its
 * last tenant.
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
import { airSystem } from "./air";
import { combatSystem } from "./combat";
import { constructionSystem } from "./construction";
import { economySystem } from "./economy";
import { navalSystem } from "./naval";
import { productionSystem } from "./production";
import { regentSystem } from "./regent";
import { researchSystem } from "./research";
import { supplySystem } from "./supply";
import { tradeSystem } from "./trade";
import { victorySystem } from "./victory";

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

export const SYSTEMS: readonly System[] = [
  economySystem,
  constructionSystem,
  productionSystem,
  researchSystem,
  tradeSystem,
  supplySystem,
  airSystem,
  navalSystem,
  combatSystem,
  regentSystem,
  victorySystem,
];
