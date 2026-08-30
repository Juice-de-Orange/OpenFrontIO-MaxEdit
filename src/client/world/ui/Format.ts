/**
 * The one number vocabulary, in one place.
 *
 * CLAUDE.md invariant 9: rates are shown per in-game day and never per tick,
 * capacities are a filled fraction, and modifiers are signed percentages.
 * Every screen calls these; none of them formats a number itself. The
 * conversion from the simulation's per-tick figures lives here and nowhere
 * else, so there is exactly one place it can be got wrong.
 */

import { TICKS_PER_DAY } from "src/shared/config/time";
import { t } from "./strings";

/** A per-tick rate, as the player reads it: per in-game day. */
export function perDay(perTick: number): string {
  return t("economy.perDay", { value: round(perTick * TICKS_PER_DAY) });
}

/** A stockpile or any other absolute amount. */
export function amount(value: number): string {
  return round(value);
}

/** A capacity, as a filled fraction. Never "4 free of 6". */
export function fraction(used: number, total: number): string {
  return `${used} / ${total}`;
}

/** A modifier, always signed. */
export function percent(ratio: number): string {
  const value = Math.round(ratio * 100);
  return `${value >= 0 ? "+" : ""}${value}%`;
}

/** A share of something, unsigned — "84%" rather than "+84%". */
export function share(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * In-game days remaining, rounded up.
 *
 * Up, not to nearest: "1 day left" on something that needs another thirty
 * hours is the kind of small lie a player notices once and then stops
 * believing the rest of the screen.
 */
export function daysRemaining(remaining: number, perTick: number): number {
  if (perTick <= 0) return Infinity;
  return Math.ceil(remaining / perTick / TICKS_PER_DAY);
}

function round(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return String(Math.round(value));
  if (magnitude >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
