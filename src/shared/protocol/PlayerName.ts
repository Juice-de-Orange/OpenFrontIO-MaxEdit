/**
 * The one rule about a player's name, shared by both sides of the wire.
 *
 * A name is the only free text a player ever puts into this world, and it is
 * shown to every other player in place of the regent's persona (decision
 * 0024). There is no censor in this fork — the inherited one is quarantined —
 * so the rule is narrow instead: letters, digits, spaces and three marks, two
 * to twenty-four characters, whitespace collapsed. The server applies it on
 * registration and the client applies it before asking, so a name the server
 * would refuse is never sent.
 *
 * Names never enter the simulation (decision 0019): they live on the account
 * and reach the wire only as the `ruler` of a claimed nation.
 */

export const MIN_PLAYER_NAME = 2;
export const MAX_PLAYER_NAME = 24;

/** What an account is called when the player gave no name. Shown as nobody. */
export const NO_PLAYER_NAME = "Anonymous";

const ALLOWED = /^[\p{L}\p{N} .'-]+$/u;

/**
 * The name as it will be stored, or null for one the rule refuses. An empty
 * or whitespace-only name is not refused — it is no name, and the caller
 * stores `NO_PLAYER_NAME`.
 */
export function normalisePlayerName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0) return "";
  if (name.length < MIN_PLAYER_NAME || name.length > MAX_PLAYER_NAME) {
    return null;
  }
  return ALLOWED.test(name) ? name : null;
}

/** Whether an account's stored name is one a player chose. */
export function hasPlayerName(name: string): boolean {
  return name.length > 0 && name !== NO_PLAYER_NAME;
}
