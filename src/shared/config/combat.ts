/**
 * The front, and what decides a province.
 *
 * CLAUDE.md §6.9: combat is **front-based, not unit-based**. A player orders an
 * attack on a province and that order stands; every tick it is resolved again
 * against whatever is holding the place, and it grinds until it succeeds, the
 * player withdraws it, or the province becomes theirs some other way.
 *
 * The inputs are the ones §6.9 lists — equipment, supply, terrain, combat width
 * — and the roll is seeded from `(worldSeed, tick, province)` so the tick stays
 * reproducible from the log (§9). Air superiority joins them in phase 8; there
 * is one multiplier waiting for it and nothing else to change.
 */

import { TerrainType } from "../map/Terrain";

/**
 * How much force can meet at one province border at once.
 *
 * §6.9 asks for this by name and gives the reason: numerical superiority has to
 * have diminishing returns, or a stack of twenty divisions decides everything
 * and there is no front, only a hammer. Strength above the width is not
 * discarded — it is simply not in the fight this tick.
 */
export const COMBAT_WIDTH = 3;

/**
 * What the defender's ground is worth, per terrain.
 *
 * Multiplies defending strength. Mountains are not a wall — nothing in this
 * game is a wall (invariant 2) — they are expensive.
 */
export const TERRAIN_DEFENCE: Readonly<Record<TerrainType, number>> = {
  [TerrainType.Plains]: 1,
  [TerrainType.Highland]: 1.35,
  [TerrainType.Mountain]: 1.8,
  // Neither can hold a division, and neither is ever a province's terrain.
  // Present so the table is total and a new terrain cannot be forgotten.
  [TerrainType.Ocean]: 1,
  [TerrainType.Impassable]: 1,
} as const;

/**
 * How much of the roll is chance rather than force.
 *
 * The roll multiplies the attacker's strength by a factor in
 * `[1 - COMBAT_LUCK, 1 + COMBAT_LUCK]`. At zero the stronger side always wins
 * and a front never surprises anybody; at one a single division takes a
 * fortress on a good day. A fifth is enough that a marginal attack is a
 * gamble and a decisive one is not.
 */
export const COMBAT_LUCK = 0.2;

/**
 * What a tick of fighting costs each side, as a share of what its divisions
 * hold.
 *
 * The attacker pays more: it is the one leaving its ground. Both are small
 * because §6.9 wants a front that grinds for in-game weeks — what makes it
 * felt is that it happens every tick for as long as the order stands.
 */
export const ATTACKER_LOSS = 0.05;
export const DEFENDER_LOSS = 0.035;

/**
 * How fast a front moves when one side completely dominates the other.
 *
 * Each tick a standing attack advances by
 * `FRONT_ADVANCE × (pressed − defence) / (pressed + defence)` — positive when
 * the attacker is ahead, negative when behind — and the province changes
 * hands when the accumulated progress reaches 1. This is the number that
 * decides whether the war feels slow, and §6.9 wants slow: at total dominance
 * a province falls in 20 ticks, most of an in-game day; at two-to-one the
 * ratio is a third and the front needs two and a half days; at parity it
 * wobbles with the luck roll and goes nowhere, which turns an even fight into
 * the attrition war the per-tick losses are for.
 */
export const FRONT_ADVANCE = 0.05;

/**
 * How fast an uncontested province is walked into.
 *
 * No defending division means no battle (§6.9 resolves battles, not marches),
 * but invariant 1 still forbids the lump sum this used to be: empty ground
 * changed hands in one tick. A third of an in-game day to march in — fast
 * enough that `claim_province` stays the instrument the early phases built
 * on, slow enough that a player watching the map sees it happen. An eighth
 * exactly, because eight additions of it reach 1.0 without floating-point
 * residue: the march takes eight ticks, not sometimes nine.
 */
export const FRONT_MARCH_ADVANCE = 1 / 8;

/**
 * How far below its supply a division fights.
 *
 * Strength is multiplied by `SUPPLY_FLOOR + (1 - SUPPLY_FLOOR) * supply`, so a
 * completely unsupplied division still fights at the floor rather than
 * vanishing — degrade, never block. §6.6 already takes its equipment away;
 * taking its strength as well would be the same punishment twice.
 */
export const COMBAT_SUPPLY_FLOOR = 0.25;
