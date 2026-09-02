/**
 * Where a nation's name goes on the map.
 *
 * The first version put the label on the centre of the largest province a
 * nation held, which is right for a round nation and wrong for every other
 * shape: a coastline puts the centre in the sea, a horseshoe puts it in the
 * middle of the hole, and a long thin nation gets a name that runs off both
 * ends of it.
 *
 * Upstream solved this and the solution is quarantined in
 * `_legacy/hud/NameBoxCalculator.ts`: find the **largest axis-aligned
 * rectangle inscribed in the territory**, put the name in the middle of it,
 * and size the font to the rectangle. The search is a histogram scan — for
 * each row, the running column heights are a histogram, and the largest
 * rectangle in a histogram is the classic stack problem — so the whole thing
 * is O(cells) over a grid that is deliberately coarse.
 *
 * This is that algorithm, ported to what this fork has: no `Game`, no
 * `Player`, no tiles-as-objects. The caller says what counts as "inside"
 * and over what box to look, and gets a point and a size back. Everything
 * here is pure, which is what makes it testable against hand-drawn grids —
 * the reason the port exists rather than an import.
 */

/** A tile-space bounding box, inclusive on both ends. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the name sits and how tall it is, in tiles. */
export interface Label {
  x: number;
  y: number;
  size: number;
}

/**
 * How coarse a grid to search, from the size of the box.
 *
 * Upstream's ladder, kept: the search is quadratic in the grid, and a
 * continent-sized nation at tile resolution would be millions of cells for a
 * label nobody will measure. The coarser the grid the blockier the rectangle,
 * which costs a label a few tiles of centring and nothing else.
 */
export function scaleFor(box: Box): number {
  const size = Math.min(box.maxX - box.minX, box.maxY - box.minY);
  if (size < 25) return 1;
  if (size < 50) return 2;
  if (size < 100) return 4;
  if (size < 250) return 8;
  if (size < 500) return 16;
  return 32;
}

/**
 * The largest rectangle under a histogram, by the standard stack scan.
 *
 * `heights[i]` is how many rows deep column `i` currently runs. The stack
 * holds columns whose rectangle is still open; when a shorter column arrives
 * every taller one is closed and measured. O(n), one pass.
 */
export function largestRectangleInHistogram(heights: readonly number[]): Rect {
  const stack: number[] = [];
  let best: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let bestArea = 0;

  for (let i = 0; i <= heights.length; i++) {
    const here = i === heights.length ? 0 : heights[i];
    while (stack.length > 0 && here < heights[stack[stack.length - 1]]) {
      const height = heights[stack[stack.length - 1]];
      stack.pop();
      const left = stack.length === 0 ? 0 : stack[stack.length - 1] + 1;
      const width = i - left;
      if (height * width > bestArea) {
        bestArea = height * width;
        best = { x: left, y: 0, width, height };
      }
    }
    stack.push(i);
  }
  return best;
}

/**
 * The largest rectangle that fits inside the true cells of a grid.
 *
 * `grid[col][row]`, the same orientation upstream used, because the columns
 * are what the histogram counts.
 */
export function findLargestInscribedRectangle(
  grid: readonly (readonly boolean[])[],
): Rect {
  const cols = grid.length;
  const rows = cols === 0 ? 0 : grid[0].length;
  const heights = new Array<number>(cols).fill(0);
  let best: Rect = { x: 0, y: 0, width: 0, height: 0 };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      heights[col] = grid[col][row] ? heights[col] + 1 : 0;
    }
    const here = largestRectangleInHistogram(heights);
    if (here.width * here.height > best.width * best.height) {
      best = {
        x: here.x,
        y: row - here.height + 1,
        width: here.width,
        height: here.height,
      };
    }
  }
  return best;
}

/**
 * A font size the name fits in the rectangle at.
 *
 * Width by the letters, height by three lines' worth of room — upstream's
 * rule of thumb, and close enough for a label whose only job is to be
 * readable at the zoom the nation fills the screen at.
 */
export function fontSizeFor(rect: Rect, nameLength: number): number {
  const byWidth = (rect.width / Math.max(1, nameLength)) * 2;
  const byHeight = rect.height / 3;
  return Math.min(byWidth, byHeight);
}

export interface PlacementRequest {
  box: Box;
  /** Whether a tile counts as this nation's ground. */
  inside: (x: number, y: number) => boolean;
  nameLength: number;
  minSize: number;
  maxSize: number;
}

/**
 * The label for one nation, or null when the box holds nothing at all.
 *
 * The point is the middle of the largest inscribed rectangle, lifted by a
 * third of the font size: glyphs hang below their anchor, so the visual
 * centre sits lower than the point the renderer is given.
 */
export function placeLabel(request: PlacementRequest): Label | null {
  const { box, inside, nameLength, minSize, maxSize } = request;
  if (box.maxX < box.minX || box.maxY < box.minY) return null;
  const scale = scaleFor(box);

  const cols = Math.floor((box.maxX - box.minX) / scale) + 1;
  const rows = Math.floor((box.maxY - box.minY) / scale) + 1;
  const grid: boolean[][] = [];
  for (let col = 0; col < cols; col++) {
    const column = new Array<boolean>(rows);
    for (let row = 0; row < rows; row++) {
      column[row] = inside(box.minX + col * scale, box.minY + row * scale);
    }
    grid.push(column);
  }

  const rect = findLargestInscribedRectangle(grid);
  if (rect.width === 0 || rect.height === 0) return null;
  const scaled: Rect = {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
  const size = Math.min(
    maxSize,
    Math.max(minSize, fontSizeFor(scaled, nameLength)),
  );
  return {
    x: Math.round(box.minX + scaled.x + scaled.width / 2),
    y: Math.round(box.minY + scaled.y + scaled.height / 2 - size / 3),
    size,
  };
}
