/**
 * Number formatting: one vocabulary for every number the game shows.
 *
 * Design invariant 9 asks for exactly one such vocabulary across every screen,
 * and both sides need it — the renderer for its labels, and the simulation for
 * the message text it generates (AttackExecution, TransportShipExecution,
 * TradeShipExecution and GameImpl all format troop and gold figures). Two
 * sides needing the same answer is what puts it in shared/.
 *
 * It sat in client/Utils.ts, which imports core/game/Game and core/Schemas,
 * so the renderer could not reach it without dragging the simulation in.
 * Putting it under render/ instead would have inverted the problem: the four
 * core files above import these through Utils, so the edge would have run
 * core -> client/render.
 *
 * Pure: no imports, no DOM, no translation. Duration formatting stays in
 * client/Utils.ts because it needs translateText.
 */

export function renderNumber(
  num: number | bigint,
  fixedPoints?: number,
): string {
  num = Number(num);
  num = Math.max(num, 0);

  if (num >= 10_000_000_000) {
    const value = Math.floor(num / 100000000) / 10;
    return value.toFixed(fixedPoints ?? 1) + "B";
  } else if (num >= 1_000_000_000) {
    const value = Math.floor(num / 10000000) / 100;
    return value.toFixed(fixedPoints ?? 2) + "B";
  } else if (num >= 10_000_000) {
    const value = Math.floor(num / 100000) / 10;
    return value.toFixed(fixedPoints ?? 1) + "M";
  } else if (num >= 1_000_000) {
    const value = Math.floor(num / 10000) / 100;
    return value.toFixed(fixedPoints ?? 2) + "M";
  } else if (num >= 100000) {
    return Math.floor(num / 1000) + "K";
  } else if (num >= 10000) {
    const value = Math.floor(num / 100) / 10;
    return value.toFixed(fixedPoints ?? 1) + "K";
  } else if (num >= 1000) {
    const value = Math.floor(num / 10) / 100;
    return value.toFixed(fixedPoints ?? 2) + "K";
  } else {
    return Math.floor(num).toString();
  }
}

export function renderTroops(troops: number): string {
  return renderNumber(troops / 10);
}

export function formatPercentage(value: number): string {
  const perc = value * 100;
  if (Number.isNaN(perc)) return "0%";
  return perc.toFixed(1) + "%";
}
