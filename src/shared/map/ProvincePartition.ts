/**
 * The province partition: nation territories first, then subdivisions.
 *
 * The shape of the result is the point. A province never straddles a national
 * border, because the borders *are* province borders — territory is grown
 * from the capitals in the map manifest, and only then cut into pieces. That
 * gives the political map its familiar look, and it makes the mechanics
 * honest: an ownership change moves one province, and the front between two
 * nations is a set of province edges rather than an arbitrary line through a
 * grid cell.
 *
 * Both sides run this on the same terrain bytes and must get the same answer.
 * It is therefore strictly deterministic: fixed neighbour order, FIFO queues,
 * no Math.random, no Map iteration where order matters. `terrainHashFnv1a`
 * plus the province count let the two sides check they agreed.
 *
 * Cost on Europe at quarter resolution (1452x836, 568k land tiles): both
 * passes are linear in tiles and complete in well under a second.
 */

import { LAND_BIT } from "./TerrainBits";

/**
 * Target tiles per province.
 *
 * Chosen so Europe lands in the 300–800 range the specification asks for.
 * It is a size, not a count: a large nation gets more provinces than a small
 * one, so area keeps meaning something.
 */
const TARGET_PROVINCE_TILES = 900;

/** No nation gets fewer than one province or more than this many. */
const MAX_PROVINCES_PER_NATION = 40;

/** Lloyd relaxation passes over the subdivision seeds. */
const RELAXATION_PASSES = 2;

export interface NationSeed {
  /** Tile-space capital position. */
  x: number;
  y: number;
}

export interface ProvincePartition {
  count: number;
  /** Province id per tile, -1 for water. Length is width*height. */
  provinceOfTile: Int32Array;
  /** Nation index (0-based, into the seed list) that each province starts under. */
  nationOfProvince: Int32Array;
  /** Tile-space centre of each province. */
  centres: { x: number; y: number }[];
  /** Province adjacency, sorted ascending. */
  neighbours: number[][];
}

/** 4-neighbourhood, in a fixed order so the flood is reproducible. */
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

/**
 * Grow every seed at the same rate over the land, so each tile falls to the
 * nation whose capital reaches it first.
 *
 * This is what makes the borders look like borders: the boundary between two
 * nations ends up equidistant from their capitals along the *land*, so it
 * bends around bays and runs through mountains and isthmuses the way a real
 * frontier does — rather than cutting straight through them.
 *
 * Tiles no seed can reach over land (offshore islands) stay unassigned.
 */
function growNations(
  terrain: Uint8Array,
  width: number,
  height: number,
  seeds: NationSeed[],
): Int32Array {
  const owner = new Int32Array(terrain.length).fill(-1);
  if (seeds.length === 0) return owner;

  // A plain FIFO queue of tile indices. Uniform edge cost, so breadth-first
  // order is already distance order — no priority queue needed.
  const queue = new Int32Array(terrain.length);
  let head = 0;
  let tail = 0;

  seeds.forEach((seed, nation) => {
    const x = Math.min(width - 1, Math.max(0, Math.round(seed.x)));
    const y = Math.min(height - 1, Math.max(0, Math.round(seed.y)));
    const start = nearestLandTile(terrain, width, height, x, y);
    // A capital that resolves onto a tile another seed already took keeps the
    // earlier claim; the later nation simply starts from its next free tile.
    if (start >= 0 && owner[start] === -1) {
      owner[start] = nation;
      queue[tail++] = start;
    }
  });

  while (head < tail) {
    const tile = queue[head++];
    const nation = owner[tile];
    const x = tile % width;
    const y = (tile / width) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (owner[n] !== -1) continue;
      if ((terrain[n] & LAND_BIT) === 0) continue;
      owner[n] = nation;
      queue[tail++] = n;
    }
  }
  return owner;
}

/**
 * The nearest land tile to (x, y), searched in rings. -1 if the map has none.
 *
 * Exported because the attribute derivation has to resolve a capital to the
 * same tile the partition resolved it to. Two ring searches that disagree by
 * one tile would put the capital bonus on the wrong province, and nothing
 * would report it.
 */
export function nearestLandTile(
  terrain: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const at = (px: number, py: number): number =>
    px < 0 || py < 0 || px >= width || py >= height ? -1 : py * width + px;

  const here = at(x, y);
  if (here >= 0 && (terrain[here] & LAND_BIT) !== 0) return here;

  for (let r = 1; r < Math.max(width, height); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Ring only, not the filled square.
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const i = at(x + dx, y + dy);
        if (i >= 0 && (terrain[i] & LAND_BIT) !== 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Cut one nation's territory into `k` pieces.
 *
 * Seeds are placed on a coarse lattice over the territory's bounding box and
 * pulled to the nearest owned tile, then a multi-source flood *restricted to
 * that territory* grows them. Restricting the flood is what keeps a province
 * from leaking across the national border.
 *
 * Lloyd relaxation afterwards evens the sizes out: each seed moves to the
 * centre of mass of what it captured, and the flood runs again.
 */
function subdivide(
  tiles: Int32Array,
  width: number,
  k: number,
  ownerOfTile: Int32Array,
  nation: number,
  out: Int32Array,
  firstId: number,
): number {
  if (k <= 1) {
    for (let i = 0; i < tiles.length; i++) out[tiles[i]] = firstId;
    return 1;
  }

  // Bounding box, to spread the initial seeds over.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < tiles.length; i++) {
    const x = tiles[i] % width;
    const y = (tiles[i] / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // A lattice with roughly k cells, biased to the territory's aspect ratio so
  // long thin countries get cut along their length rather than across it.
  const aspect = (maxX - minX + 1) / (maxY - minY + 1);
  const cols = Math.max(1, Math.round(Math.sqrt(k * aspect)));
  const rows = Math.max(1, Math.ceil(k / cols));

  let seeds: number[] = [];
  for (let r = 0; r < rows && seeds.length < k; r++) {
    for (let c = 0; c < cols && seeds.length < k; c++) {
      const sx = Math.round(minX + ((c + 0.5) * (maxX - minX + 1)) / cols);
      const sy = Math.round(minY + ((r + 0.5) * (maxY - minY + 1)) / rows);
      const seed = nearestOwnedTile(tiles, width, ownerOfTile, nation, sx, sy);
      if (seed >= 0 && !seeds.includes(seed)) seeds.push(seed);
    }
  }
  if (seeds.length === 0) seeds = [tiles[0]];

  const label = new Int32Array(tiles.length);
  for (let pass = 0; pass <= RELAXATION_PASSES; pass++) {
    floodWithin(tiles, width, ownerOfTile, nation, seeds, out, firstId);
    if (pass === RELAXATION_PASSES) break;

    // Centre of mass per piece, snapped back onto owned land.
    const sumX = new Float64Array(seeds.length);
    const sumY = new Float64Array(seeds.length);
    const n = new Int32Array(seeds.length);
    for (let i = 0; i < tiles.length; i++) {
      const id = out[tiles[i]] - firstId;
      if (id < 0 || id >= seeds.length) continue;
      sumX[id] += tiles[i] % width;
      sumY[id] += (tiles[i] / width) | 0;
      n[id]++;
      label[i] = id;
    }
    const moved: number[] = [];
    for (let s = 0; s < seeds.length; s++) {
      if (n[s] === 0) {
        moved.push(seeds[s]);
        continue;
      }
      const cx = Math.round(sumX[s] / n[s]);
      const cy = Math.round(sumY[s] / n[s]);
      const t = nearestOwnedTile(tiles, width, ownerOfTile, nation, cx, cy);
      moved.push(t >= 0 ? t : seeds[s]);
    }
    seeds = moved;
  }

  // Empty pieces would leave holes in the id sequence; count what was used.
  const used = new Set<number>();
  for (let i = 0; i < tiles.length; i++) used.add(out[tiles[i]]);
  return compactIds(tiles, out, firstId, used);
}

/** Nearest tile of this nation to (x, y), by squared distance. */
function nearestOwnedTile(
  tiles: Int32Array,
  width: number,
  ownerOfTile: Int32Array,
  nation: number,
  x: number,
  y: number,
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (ownerOfTile[t] !== nation) continue;
    const dx = (t % width) - x;
    const dy = ((t / width) | 0) - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** Multi-source flood confined to one nation's tiles. */
function floodWithin(
  tiles: Int32Array,
  width: number,
  ownerOfTile: Int32Array,
  nation: number,
  seeds: number[],
  out: Int32Array,
  firstId: number,
): void {
  for (let i = 0; i < tiles.length; i++) out[tiles[i]] = -1;

  const queue = new Int32Array(tiles.length);
  let head = 0;
  let tail = 0;
  seeds.forEach((seed, s) => {
    if (out[seed] === -1) {
      out[seed] = firstId + s;
      queue[tail++] = seed;
    }
  });

  while (head < tail) {
    const tile = queue[head++];
    const id = out[tile];
    const x = tile % width;
    const y = (tile / width) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0) continue;
      const n = ny * width + nx;
      if (n < 0 || n >= ownerOfTile.length) continue;
      if (nx >= width) continue;
      if (ownerOfTile[n] !== nation) continue;
      if (out[n] !== -1) continue;
      out[n] = id;
      queue[tail++] = n;
    }
  }

  // Anything the flood could not reach (a detached exclave of this nation)
  // joins the nearest piece by id rather than becoming a hole.
  for (let i = 0; i < tiles.length; i++) {
    if (out[tiles[i]] === -1) out[tiles[i]] = firstId;
  }
}

/** Renumber a nation's pieces so ids are contiguous from firstId. */
function compactIds(
  tiles: Int32Array,
  out: Int32Array,
  firstId: number,
  used: Set<number>,
): number {
  const sorted = [...used].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  sorted.forEach((id, i) => remap.set(id, firstId + i));
  for (let i = 0; i < tiles.length; i++) {
    out[tiles[i]] = remap.get(out[tiles[i]])!;
  }
  return sorted.length;
}

/**
 * Partition the land into provinces that respect national borders.
 */
export function computeProvincePartition(
  terrain: Uint8Array,
  width: number,
  height: number,
  seeds: NationSeed[],
): ProvincePartition {
  if (terrain.length !== width * height) {
    throw new Error(
      `terrain is ${terrain.length} bytes, expected ${width * height}`,
    );
  }

  const nationOfTile = growNations(terrain, width, height, seeds);

  // Collect each nation's tiles once; every later pass works on these lists.
  const tilesByNation: number[][] = Array.from(
    { length: seeds.length },
    () => [],
  );
  for (let i = 0; i < nationOfTile.length; i++) {
    const n = nationOfTile[i];
    if (n >= 0) tilesByNation[n].push(i);
  }

  const provinceOfTile = new Int32Array(terrain.length).fill(-1);
  const nationOfProvinceList: number[] = [];
  let nextId = 0;

  for (let nation = 0; nation < seeds.length; nation++) {
    const list = tilesByNation[nation];
    if (list.length === 0) continue;
    const tiles = Int32Array.from(list);

    const k = Math.min(
      MAX_PROVINCES_PER_NATION,
      Math.max(1, Math.round(tiles.length / TARGET_PROVINCE_TILES)),
    );
    const made = subdivide(
      tiles,
      width,
      k,
      nationOfTile,
      nation,
      provinceOfTile,
      nextId,
    );
    for (let i = 0; i < made; i++) nationOfProvinceList.push(nation);
    nextId += made;
  }

  const count = nextId;
  const centres = computeCentres(provinceOfTile, width, count);

  return {
    count,
    provinceOfTile,
    nationOfProvince: Int32Array.from(nationOfProvinceList),
    centres,
    neighbours: computeNeighbours(provinceOfTile, width, count),
  };
}

function computeCentres(
  provinceOfTile: Int32Array,
  width: number,
  count: number,
): { x: number; y: number }[] {
  const sumX = new Float64Array(count);
  const sumY = new Float64Array(count);
  const n = new Int32Array(count);
  for (let i = 0; i < provinceOfTile.length; i++) {
    const p = provinceOfTile[i];
    if (p < 0) continue;
    sumX[p] += i % width;
    sumY[p] += (i / width) | 0;
    n[p]++;
  }
  const centres: { x: number; y: number }[] = [];
  for (let p = 0; p < count; p++) {
    centres.push(
      n[p] === 0
        ? { x: 0, y: 0 }
        : { x: Math.round(sumX[p] / n[p]), y: Math.round(sumY[p] / n[p]) },
    );
  }
  return centres;
}

/** Provinces sharing a tile edge, as sorted arrays. */
function computeNeighbours(
  provinceOfTile: Int32Array,
  width: number,
  count: number,
): number[][] {
  const sets = Array.from({ length: count }, () => new Set<number>());
  const height = provinceOfTile.length / width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = provinceOfTile[y * width + x];
      if (a < 0) continue;
      if (x + 1 < width) {
        const b = provinceOfTile[y * width + x + 1];
        if (b >= 0 && b !== a) {
          sets[a].add(b);
          sets[b].add(a);
        }
      }
      if (y + 1 < height) {
        const b = provinceOfTile[(y + 1) * width + x];
        if (b >= 0 && b !== a) {
          sets[a].add(b);
          sets[b].add(a);
        }
      }
    }
  }
  // Sorted arrays, not Sets: Set iteration order is insertion order, and
  // anything order-dependent has to be reproducible.
  return sets.map((s) => [...s].sort((p, q) => p - q));
}
