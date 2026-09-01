/**
 * How a season is won, and when it simply ends.
 *
 * §10, decided: an alliance bloc holding 40% of all provinces for 7 in-game
 * days wins outright; if nobody does, the season ends after six weeks of
 * wall clock and the highest score wins — provinces, industry, trust. Blocs
 * rather than nations, because evaluating individuals makes alliances
 * strictly self-defeating and nobody would form one (§6.5).
 *
 * Blocs are transitive over live alliances (decision 0020): allied-with-my-
 * ally is in my bloc, because shared victory eligibility is the point of an
 * alliance and a chain that wins together is what "bloc" means.
 */

import { TICK_MS, TICKS_PER_DAY } from "./time";

/** The share of all provinces a bloc must hold to start the clock. */
export const VICTORY_SHARE = 0.4;

/** How long it must hold them: seven in-game days (§10). */
export const VICTORY_HOLD_TICKS = 7 * TICKS_PER_DAY;

/**
 * When an unwon season ends: six weeks of wall clock, expressed in ticks so
 * a faster test world ends sooner by the same rule (decision 0003 — the
 * schedule is anchored to the tick).
 */
export const SEASON_TICKS = Math.round((6 * 7 * 24 * 3600 * 1000) / TICK_MS);

/**
 * The score, §10's own order: provinces, industry, trust.
 *
 * A province is the unit everything resolves to (invariant 8), so it is the
 * unit of score. Industry per tick is single digits and trust is 0..100;
 * the weights put a strong economy and a kept word in the same range as a
 * modest border war, so none of the three is cosmetic.
 */
export const SCORE_PROVINCE = 1;
export const SCORE_INDUSTRY = 10;
export const SCORE_TRUST = 0.2;
