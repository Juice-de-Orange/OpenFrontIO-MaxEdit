/**
 * Everything a province is, derived from the terrain it sits on.
 *
 * Runs in the generator only (`scripts/genProvinces.ts`), never at startup and
 * never in a system. The result is checked in beside the map, so a change here
 * moves the world's geography and has to be a deliberate, reviewed,
 * regenerated commit — see docs/decisions/0006.
 *
 * **Strictly deterministic**, in exactly the way `ProvincePartition.ts` is:
 * fixed neighbour order, FIFO queues, no `Math.random()`, no iteration over a
 * `Map` where the order matters. The one source of variation is a seeded
 * `PseudoRandom`, and it is keyed on the *terrain hash* rather than on a world
 * seed — deposits are geography, so two worlds on Europe find their coal in
 * the same mountains.
 */

import {
  AIR_ZONE_TARGET_PROVINCES,
  BUILDING_SLOTS_CAPITAL_BONUS,
  BUILDING_SLOTS_MAX,
  BUILDING_SLOTS_MIN,
  DEPOSIT_RULES,
  INFRASTRUCTURE_BY_TERRAIN,
  INFRASTRUCTURE_CAPITAL_BONUS,
  INFRASTRUCTURE_COASTAL_BONUS,
  INFRASTRUCTURE_MAX,
  INFRASTRUCTURE_MIN,
  RESOURCES,
  SEA_ZONE_TARGET_TILES,
  TILES_PER_BUILDING_SLOT,
  type Resource,
} from "../config/provinces";
import { PseudoRandom } from "../util/PseudoRandom";
import type { Province } from "./Province";
import type { ProvincePartition } from "./ProvincePartition";
import { nearestLandTile } from "./ProvincePartition";
import { TerrainType } from "./Terrain";
import { isOceanByte, terrainTypeOfByte } from "./TerrainBits";

/** 4-neighbourhood in the same fixed order the partition uses. */
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

/** Marks a water tile no sea zone reached — an enclosed lake too small to zone. */
export const NO_SEA_ZONE = -1;

export interface DerivedProvinces {
  provinces: Province[];
  /** Sea zone per tile, NO_SEA_ZONE for land and for unzoned water. */
  seaZoneOfTile: Int32Array;
  airZoneCount: number;
  seaZoneCount: number;
}

export interface DeriveInput {
  terrain: Uint8Array;
  width: number;
  height: number;
  partition: ProvincePartition;
  /** Nation capitals in tile space, in nation order, as the partition saw them. */
  capitals: { x: number; y: number }[];
  /** Seeds the deposit roll. The map's terrain hash, not a world seed. */
  terrainHash: number;
}

export function deriveProvinces(input: DeriveInput): DerivedProvinces {
  const { terrain, width, height, partition, capitals, terrainHash } = input;
  const { count, provinceOfTile, nationOfProvince, centres, neighbours } =
    partition;

  const stats = collectTileStats(terrain, width, height, provinceOfTile, count);
  const capitalProvinces = findCapitalProvinces(
    terrain,
    width,
    height,
    provinceOfTile,
    capitals,
  );

  const seaZones = partitionSeaZones(terrain, width, height);
  const airZone = partitionAirZones(count, neighbours);
  const seaZoneOfProvince = assignCoastalSeaZones(
    terrain,
    width,
    height,
    provinceOfTile,
    seaZones.zoneOfTile,
    count,
  );

  const provinces: Province[] = [];
  for (let id = 0; id < count; id++) {
    const capital = capitalProvinces.has(id);
    const provinceTerrain = stats.terrain[id];
    const coastal = stats.coastal[id];

    const base = INFRASTRUCTURE_BY_TERRAIN[provinceTerrain] ?? 0;
    const infrastructure = clamp(
      base +
        (coastal ? INFRASTRUCTURE_COASTAL_BONUS : 0) +
        (capital ? INFRASTRUCTURE_CAPITAL_BONUS : 0),
      INFRASTRUCTURE_MIN,
      INFRASTRUCTURE_MAX,
    );

    const buildingSlots = clamp(
      Math.round(stats.tileCount[id] / TILES_PER_BUILDING_SLOT) +
        (capital ? BUILDING_SLOTS_CAPITAL_BONUS : 0),
      BUILDING_SLOTS_MIN,
      BUILDING_SLOTS_MAX,
    );

    provinces.push({
      id,
      nation: nationOfProvince[id] + 1,
      neighbours: neighbours[id],
      airZone: airZone.zoneOfProvince[id],
      seaZone:
        seaZoneOfProvince[id] === NO_SEA_ZONE ? null : seaZoneOfProvince[id],
      terrain: provinceTerrain,
      infrastructure,
      buildingSlots,
      resourceDeposits: rollDeposits(terrainHash, id, provinceTerrain),
      tileCount: stats.tileCount[id],
      centre: centres[id],
      coastal,
      capital,
    });
  }

  return {
    provinces,
    seaZoneOfTile: seaZones.zoneOfTile,
    airZoneCount: airZone.count,
    seaZoneCount: seaZones.count,
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ---------------------------------------------------------------------------
// Terrain, size and coastline
// ---------------------------------------------------------------------------

interface TileStats {
  tileCount: Int32Array;
  terrain: TerrainType[];
  coastal: boolean[];
}

/**
 * One pass over the map for everything that is a count of tiles.
 *
 * Impassable land counts as Mountain. It is high ground with a magnitude that
 * upstream's renderer treats specially; for the simulation it is simply the
 * worst terrain there is, and giving it a fifth province type would put a
 * terrain in the tables that no rule has an entry for.
 */
function collectTileStats(
  terrain: Uint8Array,
  width: number,
  height: number,
  provinceOfTile: Int32Array,
  count: number,
): TileStats {
  const tileCount = new Int32Array(count);
  const plains = new Int32Array(count);
  const highland = new Int32Array(count);
  const mountain = new Int32Array(count);
  const coastal = new Array<boolean>(count).fill(false);

  for (let tile = 0; tile < provinceOfTile.length; tile++) {
    const province = provinceOfTile[tile];
    if (province < 0) continue;
    tileCount[province]++;

    switch (terrainTypeOfByte(terrain[tile])) {
      case TerrainType.Plains:
        plains[province]++;
        break;
      case TerrainType.Highland:
        highland[province]++;
        break;
      default:
        mountain[province]++;
        break;
    }

    if (!coastal[province] && touchesOcean(terrain, width, height, tile)) {
      coastal[province] = true;
    }
  }

  // Ties go to the milder terrain, so a province is never called a mountain
  // range on a coin toss.
  const majority: TerrainType[] = [];
  for (let p = 0; p < count; p++) {
    if (plains[p] >= highland[p] && plains[p] >= mountain[p]) {
      majority.push(TerrainType.Plains);
    } else if (highland[p] >= mountain[p]) {
      majority.push(TerrainType.Highland);
    } else {
      majority.push(TerrainType.Mountain);
    }
  }

  return { tileCount, terrain: majority, coastal };
}

function touchesOcean(
  terrain: Uint8Array,
  width: number,
  height: number,
  tile: number,
): boolean {
  const x = tile % width;
  const y = (tile / width) | 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    if (isOceanByte(terrain[ny * width + nx])) return true;
  }
  return false;
}

function findCapitalProvinces(
  terrain: Uint8Array,
  width: number,
  height: number,
  provinceOfTile: Int32Array,
  capitals: { x: number; y: number }[],
): Set<number> {
  const found = new Set<number>();
  for (const capital of capitals) {
    const x = clamp(Math.round(capital.x), 0, width - 1);
    const y = clamp(Math.round(capital.y), 0, height - 1);
    const tile = nearestLandTile(terrain, width, height, x, y);
    if (tile < 0) continue;
    const province = provinceOfTile[tile];
    if (province >= 0) found.add(province);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/**
 * One stream per province, so adding a province to a map does not reshuffle
 * the deposits of every province after it. The resources are rolled in the
 * fixed order of `RESOURCES` from that one stream.
 */
function rollDeposits(
  terrainHash: number,
  provinceId: number,
  terrain: TerrainType,
): Partial<Record<Resource, number>> {
  const random = new PseudoRandom(
    (terrainHash ^ Math.imul(provinceId, 0x9e3779b1)) | 0,
  );
  const deposits: Partial<Record<Resource, number>> = {};
  for (const resource of RESOURCES) {
    const rule = DEPOSIT_RULES[resource][terrain];
    // Both draws happen either way, so a province that fails its chance roll
    // does not shift the stream for the resources after it.
    const roll = random.next();
    const size = random.nextInt(rule?.min ?? 0, (rule?.max ?? 0) + 1);
    if (rule === undefined || roll >= rule.chance) continue;
    if (size > 0) deposits[resource] = size;
  }
  return deposits;
}

// ---------------------------------------------------------------------------
// Air zones
// ---------------------------------------------------------------------------

interface AirZones {
  zoneOfProvince: Int32Array;
  count: number;
}

/**
 * Cut the province graph into air zones of roughly equal size.
 *
 * Zones ignore national borders on purpose (§6.7): an air theatre that stopped
 * at a frontier would mean contesting air superiority with yourself.
 *
 * Two things are needed and one of them is not obvious.
 *
 * **Each connected component gets its own share of the seeds.** Europe has a
 * mainland and a dozen islands, and an island absorbs a whole seed whatever
 * its size. Seeded globally, the mainland is left short and its zones come out
 * half again too big. Splitting the budget by component also makes a small
 * island a small theatre rather than a fragment of a large one.
 *
 * **The growth is capacity-limited, not distance-limited.** A plain
 * multi-source flood equalises *radius*: every province joins the nearest
 * seed. Provinces are not uniform, so equal radius is not equal count — on
 * Europe it produced zones of 2 and of 43 against a target of 22, and Lloyd
 * relaxation barely moved it, because the shape of the graph and not the
 * placement of the seeds was the problem. Growing every zone one province per
 * round until it reaches its quota equalises the count directly, which is the
 * thing §6.7 actually specifies.
 *
 * Deterministic throughout: components ascending, seeds farthest-first with
 * ties to the lowest id, and every frontier scanned in ascending neighbour
 * order.
 */
function partitionAirZones(count: number, neighbours: number[][]): AirZones {
  const zoneOf = new Int32Array(count).fill(-1);
  if (count === 0) return { zoneOfProvince: zoneOf, count: 0 };

  let nextZone = 0;
  for (const component of connectedComponents(count, neighbours)) {
    const wanted = Math.max(
      1,
      Math.round(component.length / AIR_ZONE_TARGET_PROVINCES),
    );
    const inComponent = new Set(component);
    const seeds = pickZoneSeeds(
      component,
      neighbours,
      inComponent,
      count,
      wanted,
    );
    growBalanced(component, neighbours, inComponent, seeds, zoneOf, nextZone);
    nextZone += seeds.length;
  }

  return compactZones(zoneOf, nextZone);
}

/** The province graph's connected components, each ascending by id. */
function connectedComponents(
  count: number,
  neighbours: number[][],
): number[][] {
  const seen = new Uint8Array(count);
  const components: number[][] = [];
  for (let start = 0; start < count; start++) {
    if (seen[start] === 1) continue;
    seen[start] = 1;
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      for (const neighbour of neighbours[queue[head]]) {
        if (seen[neighbour] === 1) continue;
        seen[neighbour] = 1;
        queue.push(neighbour);
      }
    }
    components.push(queue.sort((a, b) => a - b));
  }
  return components;
}

/**
 * Seeds as far apart as the component allows: start at its lowest id, then
 * repeatedly take whichever province is furthest from every seed so far.
 *
 * Farthest-first rather than every k-th id. Province ids run nation by nation,
 * so a stride would put several seeds inside one large country and none in the
 * next three small ones.
 */
function pickZoneSeeds(
  component: number[],
  neighbours: number[][],
  inComponent: Set<number>,
  count: number,
  wanted: number,
): number[] {
  const seeds = [component[0]];
  let distance = manyToAllDistance(neighbours, seeds, inComponent, count);

  while (seeds.length < wanted) {
    let best = -1;
    let bestDistance = 0;
    for (const province of component) {
      if (distance[province] > bestDistance) {
        bestDistance = distance[province];
        best = province;
      }
    }
    if (best < 0) break;
    seeds.push(best);
    distance = manyToAllDistance(neighbours, seeds, inComponent, count);
  }
  return seeds;
}

/** Hop count from the nearest seed, -1 outside the component. */
function manyToAllDistance(
  neighbours: number[][],
  seeds: number[],
  inComponent: Set<number>,
  count: number,
): Int32Array {
  const distance = new Int32Array(count).fill(-1);
  const queue: number[] = [];
  for (const seed of seeds) {
    if (distance[seed] !== -1) continue;
    distance[seed] = 0;
    queue.push(seed);
  }
  for (let head = 0; head < queue.length; head++) {
    const province = queue[head];
    for (const neighbour of neighbours[province]) {
      if (!inComponent.has(neighbour) || distance[neighbour] !== -1) continue;
      distance[neighbour] = distance[province] + 1;
      queue.push(neighbour);
    }
  }
  return distance;
}

/**
 * Round-robin growth: every zone takes one province per round until it is
 * full, or until it is walled in by zones that got there first.
 *
 * A zone is always connected, because a province is only ever claimed as the
 * neighbour of one already in the zone. Whatever no zone could reach — a zone
 * boxed in early leaves provinces stranded behind it — is handed afterwards to
 * an adjacent zone, which is the only case where a zone ends up over quota.
 */
function growBalanced(
  component: number[],
  neighbours: number[][],
  inComponent: Set<number>,
  seeds: number[],
  zoneOf: Int32Array,
  firstZone: number,
): void {
  const quota = Math.ceil(component.length / seeds.length);
  const frontier: number[][] = seeds.map((seed) => [seed]);
  const size = new Int32Array(seeds.length);
  seeds.forEach((seed, zone) => {
    zoneOf[seed] = firstZone + zone;
    size[zone] = 1;
  });

  let claimed = seeds.length;
  let growing = true;
  while (growing && claimed < component.length) {
    growing = false;
    for (let zone = 0; zone < seeds.length; zone++) {
      if (size[zone] >= quota) continue;
      const taken = takeOne(frontier[zone], neighbours, inComponent, zoneOf);
      if (taken < 0) continue;
      zoneOf[taken] = firstZone + zone;
      size[zone]++;
      claimed++;
      growing = true;
      if (claimed === component.length) break;
    }
  }

  // Anything left over joins its *smallest* adjacent zone. Handing it to the
  // lowest-numbered one instead piled every stranded province of a region onto
  // whichever zone happened to be numbered first, and that one zone came out
  // half again over quota while its neighbours stayed under.
  let stalled = false;
  while (claimed < component.length && !stalled) {
    stalled = true;
    for (const province of component) {
      if (zoneOf[province] !== -1) continue;
      let best = -1;
      let bestSize = Infinity;
      for (const neighbour of neighbours[province]) {
        if (!inComponent.has(neighbour)) continue;
        const zone = zoneOf[neighbour];
        if (zone < 0) continue;
        const local = zone - firstZone;
        if (
          size[local] < bestSize ||
          (size[local] === bestSize && zone < best)
        ) {
          best = zone;
          bestSize = size[local];
        }
      }
      if (best < 0) continue;
      zoneOf[province] = best;
      size[best - firstZone]++;
      claimed++;
      stalled = false;
    }
  }
}

/** The lowest-numbered unclaimed province adjacent to this zone's frontier. */
function takeOne(
  frontier: number[],
  neighbours: number[][],
  inComponent: Set<number>,
  zoneOf: Int32Array,
): number {
  while (frontier.length > 0) {
    const province = frontier[0];
    let best = -1;
    for (const neighbour of neighbours[province]) {
      if (!inComponent.has(neighbour) || zoneOf[neighbour] !== -1) continue;
      if (best < 0 || neighbour < best) best = neighbour;
    }
    if (best < 0) {
      // Fully enclosed; it will never contribute again.
      frontier.shift();
      continue;
    }
    frontier.push(best);
    return best;
  }
  return -1;
}

function compactZones(zoneOf: Int32Array, zoneCount: number): AirZones {
  const remap = new Int32Array(zoneCount).fill(-1);
  let next = 0;
  for (let i = 0; i < zoneOf.length; i++) {
    const zone = zoneOf[i];
    if (zone < 0) continue;
    if (remap[zone] === -1) remap[zone] = next++;
    zoneOf[i] = remap[zone];
  }
  return { zoneOfProvince: zoneOf, count: next };
}

// ---------------------------------------------------------------------------
// Sea zones
// ---------------------------------------------------------------------------

interface SeaZones {
  zoneOfTile: Int32Array;
  count: number;
}

/**
 * Cut the ocean into zones the same way the partition cuts the land: seeds on
 * a lattice, then a multi-source flood at uniform speed.
 *
 * Invariant 5 asks for one zone abstraction. This is the same flood as
 * `growNations`, over the ocean instead of the land, and phase 9 assigns
 * fleets to what comes out of it.
 *
 * **Ocean, not water.** The terrain byte distinguishes ocean from inland
 * lakes, and a lake is not a theatre: a fleet cannot sail to it, a convoy
 * cannot cross it, and a province on its shore is not coastal. Zoning it
 * anyway gave landlocked provinces a sea zone and no coast — which is how
 * this distinction was found.
 */
function partitionSeaZones(
  terrain: Uint8Array,
  width: number,
  height: number,
): SeaZones {
  let oceanTiles = 0;
  for (let i = 0; i < terrain.length; i++) {
    if (isOceanByte(terrain[i])) oceanTiles++;
  }
  const zoneOfTile = new Int32Array(terrain.length).fill(NO_SEA_ZONE);
  if (oceanTiles === 0) return { zoneOfTile, count: 0 };

  const wanted = Math.max(1, Math.round(oceanTiles / SEA_ZONE_TARGET_TILES));
  const aspect = width / height;
  const cols = Math.max(1, Math.round(Math.sqrt(wanted * aspect)));
  const rows = Math.max(1, Math.ceil(wanted / cols));

  const queue = new Int32Array(terrain.length);
  let head = 0;
  let tail = 0;
  let count = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = Math.round(((c + 0.5) * width) / cols);
      const sy = Math.round(((r + 0.5) * height) / rows);
      const seed = nearestOceanTile(terrain, width, height, sx, sy);
      if (seed < 0 || zoneOfTile[seed] !== NO_SEA_ZONE) continue;
      zoneOfTile[seed] = count++;
      queue[tail++] = seed;
    }
  }
  if (count === 0) return { zoneOfTile, count: 0 };

  while (head < tail) {
    const tile = queue[head++];
    const zone = zoneOfTile[tile];
    const x = tile % width;
    const y = (tile / width) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (zoneOfTile[n] !== NO_SEA_ZONE) continue;
      if (!isOceanByte(terrain[n])) continue;
      zoneOfTile[n] = zone;
      queue[tail++] = n;
    }
  }

  return { zoneOfTile, count };
}

/** Nearest ocean tile to (x, y), searched in rings. -1 if the map has none. */
function nearestOceanTile(
  terrain: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const at = (px: number, py: number): number =>
    px < 0 || py < 0 || px >= width || py >= height ? -1 : py * width + px;

  const here = at(x, y);
  if (here >= 0 && isOceanByte(terrain[here])) return here;

  for (let r = 1; r < Math.max(width, height); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const i = at(x + dx, y + dy);
        if (i >= 0 && isOceanByte(terrain[i])) return i;
      }
    }
  }
  return -1;
}

/**
 * A coastal province takes the sea zone most of its coastline touches.
 *
 * Majority rather than first-found: a province on a strait touches two zones,
 * and which one it "is in" should be the one it has more water against, not
 * whichever tile the scan reached first.
 */
function assignCoastalSeaZones(
  terrain: Uint8Array,
  width: number,
  height: number,
  provinceOfTile: Int32Array,
  seaZoneOfTile: Int32Array,
  count: number,
): Int32Array {
  const votes: Map<number, number>[] = Array.from(
    { length: count },
    () => new Map<number, number>(),
  );

  for (let tile = 0; tile < provinceOfTile.length; tile++) {
    const province = provinceOfTile[tile];
    if (province < 0) continue;
    const x = tile % width;
    const y = (tile / width) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (!isOceanByte(terrain[n])) continue;
      const zone = seaZoneOfTile[n];
      if (zone === NO_SEA_ZONE) continue;
      votes[province].set(zone, (votes[province].get(zone) ?? 0) + 1);
    }
  }

  const result = new Int32Array(count).fill(NO_SEA_ZONE);
  for (let province = 0; province < count; province++) {
    let best = NO_SEA_ZONE;
    let bestVotes = 0;
    // Sorted, because Map iteration is insertion order and insertion order
    // here depends on the scan; a tie has to break the same way every run.
    const zones = [...votes[province].keys()].sort((a, b) => a - b);
    for (const zone of zones) {
      const n = votes[province].get(zone) ?? 0;
      if (n > bestVotes) {
        best = zone;
        bestVotes = n;
      }
    }
    result[province] = best;
  }
  return result;
}
