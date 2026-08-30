/**
 * Number formatting for anything the renderer draws.
 *
 * This is the number vocabulary of the UI -- design invariant 9 says one such
 * vocabulary across every screen -- and it belongs to the renderer rather than
 * to a client-wide grab bag. Moving it here is also what stops
 * render/gl/passes from importing client/Utils.ts, which pulls in
 * core/game/Game and core/Schemas.
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
