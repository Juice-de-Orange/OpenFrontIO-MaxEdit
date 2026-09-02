/**
 * Real national borders: Natural Earth geometry, registered onto the map.
 *
 * The hand-drawn Europe map is not a Mercator projection — it is art, and it
 * is artistically distorted. Growing nations from their capitals (the Voronoi
 * flood in `ProvincePartition`) gave every nation *a* territory, but the
 * borders were nobody's borders. This module replaces that flood with the
 * borders countries actually have, by looking every tile up in Natural Earth
 * admin-0 map units through a fitted transform.
 *
 * The transform lives in `borders-fit.json` next to the map manifest and was
 * produced offline: a quadratic warp from map pixel space into a mercator
 * lon/lat grid, refined by an elastic displacement field optimised for
 * coastline overlap (IoU 0.88) with the 52 nation spawn points as anchors.
 * This module only *evaluates* it — everything here is pure arithmetic on
 * the checked-in numbers, so a regeneration reproduces the artefact exactly.
 *
 * Natural Earth data is public domain (naturalearthdata.com); the filtered
 * geometry is checked in as `ne-borders.geojson`.
 */

import {
  nearestLandTile,
  type NationSeed,
} from "src/shared/map/ProvincePartition";
import { LAND_BIT } from "src/shared/map/TerrainBits";

/** The registration of the map onto the Natural Earth grid. */
export interface BordersFit {
  space: {
    /** The pixel space the transform was fitted in (map16x for Europe). */
    pixelWidth: number;
    pixelHeight: number;
    /** The lon/mercator grid the geometry is rasterised into. */
    gridWidth: number;
    gridHeight: number;
    lon0: number;
    lon1: number;
    lat0: number;
    lat1: number;
  };
  /** Quadratic warp coefficients over the normalised centred pixel basis. */
  quadX: number[];
  quadY: number[];
  /** Bilinear elastic displacement field, `displacement[row][col] = [dx, dy]`. */
  gridNodesX: number;
  gridNodesY: number;
  displacement: [number, number][][];
  /**
   * Sápmi is a drawn line, honestly labelled as one: the map has always had
   * a Sámi nation, and no atlas will hand us its border. Grid cells north of
   * this latitude that Natural Earth gives to Norway, Sweden or Finland
   * belong to Sápmi instead.
   */
  sapmiAboveLat: number;
}

export interface BorderFeature {
  properties: { GEOUNIT: string };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface BorderCollection {
  features: BorderFeature[];
}

/**
 * Which Natural Earth map units make up a nation, where that is not simply
 * the nation's own name. Belgium and Serbia are drawn from their regional
 * units because the game map treats them as single nations; Kosovo under
 * Serbia is the game-data call that keeps the 52-nation roster as it is,
 * not a statement about anything else.
 */
const EXTRA_GEOUNITS: Record<string, string[]> = {
  Belgium: ["Flemish Region", "Walloon Region", "Brussels Capital Region"],
  Serbia: ["Serbia", "Vojvodina", "Kosovo"],
  Türkiye: ["Turkey"],
};

/** Nations that exist on the map but not in the atlas. */
const DRAWN_NATIONS = new Set(["Sápmi"]);

/**
 * Every capital claims a disk of this radius (in tiles, over land) around
 * its spawn, whatever the atlas says. This is what keeps Monaco and Andorra
 * playable as city-states — at real scale they are smaller than a tile — and
 * what guarantees a spawn point is always inside its own nation even where
 * the registration is a pixel off (a coastal capital, a narrow country).
 */
const CAPITAL_CLAIM_RADIUS = 12;

/**
 * Assigned islands smaller than this (in tiles, and holding no capital) are
 * dropped back to unowned, like the islets the old capital flood could never
 * reach. A four-tile rock as a province helps nobody.
 */
const MIN_ISLAND_TILES = 24;

/** 4-neighbourhood in the same fixed order the partition uses. */
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

function mercator(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/**
 * Rasterise one polygon's outer ring into the grid with an even-odd
 * scanline, exactly as the offline fit did — later features overwrite
 * earlier ones, so the paint order is the feature order in the file.
 */
function fillRing(
  ring: number[][],
  fit: BordersFit,
  grid: Int16Array,
  value: number,
): void {
  const { gridWidth, gridHeight, lon0, lon1, lat0, lat1 } = fit.space;
  const m0 = mercator(lat0);
  const m1 = mercator(lat1);

  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of ring) {
    const lon = point[0];
    const lat = point[1];
    if (lat <= lat0 || lat >= lat1) continue;
    xs.push(((lon - lon0) / (lon1 - lon0)) * gridWidth);
    ys.push(((m1 - mercator(lat)) / (m1 - m0)) * gridHeight);
  }
  const n = xs.length;
  if (n < 3) return;

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const y of ys) {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const y0 = Math.max(0, Math.floor(yMin));
  const y1 = Math.min(gridHeight - 1, Math.floor(yMax) + 1);

  for (let yy = y0; yy < y1; yy++) {
    const yc = yy + 0.5;
    const nodes: number[] = [];
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const yi = ys[i];
      const yj = ys[j];
      if (yi < yc !== yj < yc) {
        nodes.push(xs[i] + ((yc - yi) / (yj - yi)) * (xs[j] - xs[i]));
      }
      j = i;
    }
    nodes.sort((a, b) => a - b);
    for (let k = 0; k + 1 < nodes.length; k += 2) {
      const a = Math.floor(Math.max(0, nodes[k]));
      const b = Math.floor(Math.min(gridWidth - 1, nodes[k + 1]));
      for (let x = a; x <= b; x++) grid[yy * gridWidth + x] = value;
    }
  }
}

/** The nation grid: 0 for nobody, nation index + 1 otherwise. */
function rasteriseNations(
  fit: BordersFit,
  borders: BorderCollection,
  names: string[],
): Int16Array {
  const nationOfUnit = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    if (DRAWN_NATIONS.has(names[i])) continue;
    for (const unit of EXTRA_GEOUNITS[names[i]] ?? [names[i]]) {
      nationOfUnit.set(unit, i);
    }
  }

  const grid = new Int16Array(fit.space.gridWidth * fit.space.gridHeight);
  const seen = new Set<string>();
  for (const feature of borders.features) {
    const unit = feature.properties.GEOUNIT;
    const nation = nationOfUnit.get(unit);
    if (nation === undefined) continue;
    seen.add(unit);
    const { type, coordinates } = feature.geometry;
    const polygons =
      type === "MultiPolygon"
        ? (coordinates as number[][][][])
        : [coordinates as number[][][]];
    for (const polygon of polygons) {
      fillRing(polygon[0], fit, grid, nation + 1);
    }
  }

  for (const unit of nationOfUnit.keys()) {
    if (!seen.has(unit)) {
      throw new Error(
        `nation borders: no Natural Earth feature for map unit "${unit}"`,
      );
    }
  }

  // Sápmi, by latitude rather than by atlas.
  const sapmi = names.indexOf("Sápmi");
  if (sapmi >= 0) {
    const { gridWidth, gridHeight, lat0, lat1 } = fit.space;
    const m0 = mercator(lat0);
    const m1 = mercator(lat1);
    const cut = Math.floor(
      ((m1 - mercator(fit.sapmiAboveLat)) / (m1 - m0)) * gridHeight,
    );
    const nordics = new Set(
      ["Norway", "Sweden", "Finland"].map((name) => names.indexOf(name) + 1),
    );
    for (let i = 0; i < cut * gridWidth; i++) {
      if (nordics.has(grid[i])) grid[i] = sapmi + 1;
    }
  }

  return grid;
}

/** Map pixel space → grid space: the quadratic warp plus the elastic field. */
function transformPoint(
  fit: BordersFit,
  px: number,
  py: number,
): { gx: number; gy: number } {
  const { pixelWidth, pixelHeight } = fit.space;
  const xf = (px - pixelWidth / 2) / pixelWidth;
  const yf = (py - pixelHeight / 2) / pixelHeight;
  const basis = [1, xf, yf, xf * xf, xf * yf, yf * yf];
  let gx = 0;
  let gy = 0;
  for (let i = 0; i < 6; i++) {
    gx += basis[i] * fit.quadX[i];
    gy += basis[i] * fit.quadY[i];
  }

  const nx = fit.gridNodesX;
  const ny = fit.gridNodesY;
  const stepX = pixelWidth / (nx - 1);
  const stepY = pixelHeight / (ny - 1);
  const fx = Math.min(Math.max(px / stepX, 0), nx - 1 - 1e-9);
  const fy = Math.min(Math.max(py / stepY, 0), ny - 1 - 1e-9);
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const d = fit.displacement;
  const dx =
    d[iy][ix][0] * (1 - tx) * (1 - ty) +
    d[iy][ix + 1][0] * tx * (1 - ty) +
    d[iy + 1][ix][0] * (1 - tx) * ty +
    d[iy + 1][ix + 1][0] * tx * ty;
  const dy =
    d[iy][ix][1] * (1 - tx) * (1 - ty) +
    d[iy][ix + 1][1] * tx * (1 - ty) +
    d[iy + 1][ix][1] * (1 - tx) * ty +
    d[iy + 1][ix + 1][1] * tx * ty;
  return { gx: gx + dx, gy: gy + dy };
}

/**
 * The nation each land tile starts under, from the atlas.
 *
 * Drop-in for the capital flood: the result has the same shape
 * (`-1` for water and for land nobody owns, else a 0-based index into the
 * seed list) and the same determinism guarantees. Four passes:
 *
 *  1. every land tile is looked up through the fitted transform;
 *  2. every capital claims its disk (`CAPITAL_CLAIM_RADIUS`);
 *  3. detached specks below `MIN_ISLAND_TILES` are dropped;
 *  4. owned land floods outward over the remaining unowned land, so the
 *     drawn coastline keeps its shape where the atlas disagrees with it.
 */
export function computeNationOfTile(
  terrain: Uint8Array,
  width: number,
  height: number,
  seeds: NationSeed[],
  names: string[],
  fit: BordersFit,
  borders: BorderCollection,
): Int32Array {
  if (seeds.length !== names.length) {
    throw new Error(
      `nation borders: ${seeds.length} seeds but ${names.length} names`,
    );
  }
  const grid = rasteriseNations(fit, borders, names);
  const { gridWidth, gridHeight, pixelWidth } = fit.space;
  const pixelPerTile = pixelWidth / width;

  // Pass 1: the atlas, through the transform.
  const owner = new Int32Array(terrain.length).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = y * width + x;
      if ((terrain[tile] & LAND_BIT) === 0) continue;
      const { gx, gy } = transformPoint(
        fit,
        (x + 0.5) * pixelPerTile,
        (y + 0.5) * pixelPerTile,
      );
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      if (cx < 0 || cy < 0 || cx >= gridWidth || cy >= gridHeight) continue;
      const id = grid[cy * gridWidth + cx];
      if (id > 0) owner[tile] = id - 1;
    }
  }

  // Pass 2: capital disks, in nation order so the claim is reproducible.
  const capitalTiles: number[] = [];
  const queue = new Int32Array(terrain.length);
  const distance = new Int32Array(terrain.length);
  seeds.forEach((seed, nation) => {
    const x = Math.min(width - 1, Math.max(0, Math.round(seed.x)));
    const y = Math.min(height - 1, Math.max(0, Math.round(seed.y)));
    const start = nearestLandTile(terrain, width, height, x, y);
    if (start < 0) return;
    capitalTiles.push(start);
    let head = 0;
    let tail = 0;
    owner[start] = nation;
    distance[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const tile = queue[head++];
      if (distance[tile] >= CAPITAL_CLAIM_RADIUS) continue;
      const tx = tile % width;
      const ty = (tile / width) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = tx + DX[d];
        const ny = ty + DY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if ((terrain[n] & LAND_BIT) === 0) continue;
        if (owner[n] === nation && distance[n] <= distance[tile] + 1) continue;
        owner[n] = nation;
        distance[n] = distance[tile] + 1;
        queue[tail++] = n;
      }
    }
  });

  dropSpecks(owner, terrain, width, height, capitalTiles);
  floodUnowned(owner, terrain, width, height);
  return owner;
}

/** Pass 3: detached owned components too small to be anybody's island. */
function dropSpecks(
  owner: Int32Array,
  terrain: Uint8Array,
  width: number,
  height: number,
  capitalTiles: number[],
): void {
  const component = new Int32Array(owner.length).fill(-1);
  const queue = new Int32Array(owner.length);
  const members: number[] = [];
  let componentId = 0;
  for (let start = 0; start < owner.length; start++) {
    if (owner[start] < 0 || component[start] >= 0) continue;
    let head = 0;
    let tail = 0;
    members.length = 0;
    component[start] = componentId;
    queue[tail++] = start;
    members.push(start);
    let hasCapital = false;
    while (head < tail) {
      const tile = queue[head++];
      const tx = tile % width;
      const ty = (tile / width) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = tx + DX[d];
        const ny = ty + DY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (owner[n] < 0 || component[n] >= 0) continue;
        component[n] = componentId;
        queue[tail++] = n;
        members.push(n);
      }
    }
    for (const capital of capitalTiles) {
      if (component[capital] === componentId) hasCapital = true;
    }
    if (members.length < MIN_ISLAND_TILES && !hasCapital) {
      for (const tile of members) owner[tile] = -1;
    }
    componentId++;
  }
}

/**
 * Pass 4: owned land floods over unowned land, breadth-first from every
 * owned tile at once, so each drawn-but-unatlassed tile joins its nearest
 * owner along the land — the same growth rule the capital flood used.
 */
function floodUnowned(
  owner: Int32Array,
  terrain: Uint8Array,
  width: number,
  height: number,
): void {
  const queue = new Int32Array(owner.length);
  let head = 0;
  let tail = 0;
  for (let tile = 0; tile < owner.length; tile++) {
    if (owner[tile] >= 0) queue[tail++] = tile;
  }
  while (head < tail) {
    const tile = queue[head++];
    const nation = owner[tile];
    const tx = tile % width;
    const ty = (tile / width) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = tx + DX[d];
      const ny = ty + DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (owner[n] !== -1) continue;
      if ((terrain[n] & LAND_BIT) === 0) continue;
      owner[n] = nation;
      queue[tail++] = n;
    }
  }
}
