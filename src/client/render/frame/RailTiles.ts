/**
 * Rail tile geometry — turning a path of tile refs into oriented rail tiles.
 *
 * Pure, no imports. `railroadState` encodes RailType + 1 per tile and the
 * shader reads that as the tile's orientation, so neither the enum's member
 * order nor its regular-enum-ness may change casually: reordering renders
 * rails with the wrong curves and breaks no test.
 *
 * This used to sit in the same file as the RailroadCache class, which is an
 * accumulator for GameUpdates events and therefore protocol adaptation rather
 * than renderer code. That class now lives in client/view/ next to the
 * GameView it serves; nothing here depends on the simulation.
 */

// Regular enum (not const enum) for cross-package use.
export enum RailType {
  VERTICAL,
  HORIZONTAL,
  TOP_LEFT,
  TOP_RIGHT,
  BOTTOM_LEFT,
  BOTTOM_RIGHT,
}

export interface RailTile {
  ref: number;
  type: RailType;
}

// ---------------------------------------------------------------------------
// Orientation helpers
// ---------------------------------------------------------------------------

function railExtremity(tile: number, next: number, w: number): RailType {
  const dx = (next % w) - (tile % w);
  const dy = (next - (next % w)) / w - (tile - (tile % w)) / w;
  if (dx === 0) return RailType.VERTICAL;
  if (dy === 0) return RailType.HORIZONTAL;
  return RailType.VERTICAL;
}

function railDirection(
  prev: number,
  cur: number,
  next: number,
  w: number,
): RailType {
  const x1 = prev % w,
    y1 = (prev - x1) / w;
  const x2 = cur % w,
    y2 = (cur - x2) / w;
  const x3 = next % w,
    y3 = (next - x3) / w;
  const dx1 = x2 - x1,
    dy1 = y2 - y1;
  const dx2 = x3 - x2,
    dy2 = y3 - y2;
  if (dx1 === dx2 && dy1 === dy2) {
    return dx1 !== 0 ? RailType.HORIZONTAL : RailType.VERTICAL;
  }
  if ((dx1 === 0 && dx2 !== 0) || (dx1 !== 0 && dx2 === 0)) {
    if (dx1 === 0 && dx2 === 1 && dy1 === -1) return RailType.BOTTOM_RIGHT;
    if (dx1 === 0 && dx2 === -1 && dy1 === -1) return RailType.BOTTOM_LEFT;
    if (dx1 === 0 && dx2 === 1 && dy1 === 1) return RailType.TOP_RIGHT;
    if (dx1 === 0 && dx2 === -1 && dy1 === 1) return RailType.TOP_LEFT;
    if (dx1 === 1 && dx2 === 0 && dy2 === -1) return RailType.TOP_LEFT;
    if (dx1 === -1 && dx2 === 0 && dy2 === -1) return RailType.TOP_RIGHT;
    if (dx1 === 1 && dx2 === 0 && dy2 === 1) return RailType.BOTTOM_LEFT;
    if (dx1 === -1 && dx2 === 0 && dy2 === 1) return RailType.BOTTOM_RIGHT;
  }
  return RailType.VERTICAL;
}

export function computeRailTiles(tileRefs: number[], w: number): RailTile[] {
  if (tileRefs.length === 0) return [];
  if (tileRefs.length === 1)
    return [{ ref: tileRefs[0]!, type: RailType.VERTICAL }];
  const result: RailTile[] = [];
  result.push({
    ref: tileRefs[0]!,
    type: railExtremity(tileRefs[0]!, tileRefs[1]!, w),
  });
  for (let i = 1; i < tileRefs.length - 1; i++) {
    result.push({
      ref: tileRefs[i]!,
      type: railDirection(tileRefs[i - 1]!, tileRefs[i]!, tileRefs[i + 1]!, w),
    });
  }
  const last = tileRefs.length - 1;
  result.push({
    ref: tileRefs[last]!,
    type: railExtremity(tileRefs[last]!, tileRefs[last - 1]!, w),
  });
  return result;
}
