/**
 * The regent: how the world plays a nation nobody is playing.
 *
 * CLAUDE.md §6.10, and it is load-bearing rather than a convenience: with a
 * five-second tick the regent plays the majority of a nation's ticks, and if
 * it cannot hold a front, players do not come back. Rule-based, no search,
 * no planning, no learning — competence at the basics, nothing else.
 *
 * Everything here is a limit or a threshold the rules read; the rules
 * themselves live in `server/systems/regent.ts`.
 */

/**
 * How often the regent thinks, in ticks. §6.10: every 12, not every tick —
 * half an in-game day. Everything it does is a standing arrangement, and a
 * steward that reacts faster than the world moves is micromanaging.
 */
export const REGENT_INTERVAL_TICKS = 12;

/** §6.10's four postures. Focus only changes allocation weights. */
export const REGENT_FOCI = [
  "economy",
  "military",
  "defence",
  "expansion",
] as const;

export type RegentFocus = (typeof REGENT_FOCI)[number];

export interface RegentConfig {
  enabled: boolean;
  focus: RegentFocus;
  /**
   * Construction points per tick it may spend on the world market to cover
   * lost imports. §6.10: this is the regent's *only* economic reaction, and
   * it exists because indefinite agreements mean an offline player can be
   * cut off with no warning.
   */
  marketBudget: number;
}

/**
 * What a nation's regent is until somebody configures it.
 *
 * **Disabled, and that is decision 0018, not an oversight.** Until phase 11
 * can tell a played nation from an abandoned one, a default-on regent plays
 * all fifty-two at once — and every gate then measures the regent instead of
 * its own subject. The season opening (phase 11/12) is where regents are
 * switched on for unclaimed nations.
 */
export const DEFAULT_REGENT: Readonly<RegentConfig> = {
  enabled: false,
  focus: "economy",
  marketBudget: 0.5,
} as const;

/** The most a player may let the regent spend at the market, per tick. */
export const MAX_REGENT_MARKET_BUDGET = 5;

/**
 * Below this strength the regent reads a fight as lost and calls the attack
 * off — the only retreat this game has, since divisions do not move (§6.9
 * resolves borders, not marches).
 */
export const REGENT_RETREAT_STRENGTH = 0.25;

/**
 * Below this supply the regent answers with a supply hub in the starving
 * division's province, before any focus spending. §6.6's lesson, learned by
 * the phase-8 gate: a division at a badly supplied front is a bottomless
 * pit, and the hub — not the army — is what fixes it.
 */
export const REGENT_HUB_BELOW = 0.5;
