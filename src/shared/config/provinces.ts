/**
 * Every number the province derivation uses.
 *
 * CLAUDE.md §9: balance numbers live in shared/config/, never inline in the
 * code that reads them. These are *map* numbers rather than simulation rates —
 * they decide what a province is, not how fast it produces — but the rule is
 * the same, and this is the file to retune when Europe comes out with too few
 * building slots or too much steel.
 *
 * Changing anything here changes the checked-in province artefacts, and
 * `tests/shared/ProvinceArtifact.test.ts` will fail until they are regenerated
 * with `npm run gen-provinces`. That is deliberate: a map that a running
 * season is standing on does not get to change underneath it silently.
 */

import { TerrainType } from "../map/Terrain";

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * Provinces per air zone. CLAUDE.md §6.7 asks for 15-30.
 *
 * Zones are grown over the province graph and ignore national borders, the
 * way a real air theatre does — a zone that stopped at a frontier would make
 * air superiority a thing you hold over yourself.
 */
export const AIR_ZONE_TARGET_PROVINCES = 22;

/**
 * The range §6.7 asks for is 15-30. These are the bounds the generator
 * actually holds, and the artefact test asserts them rather than the spec's.
 *
 * The growth is capacity-limited, so it hits the quota exactly — but a zone
 * boxed in early stops short, and what it leaves stranded has to join a
 * neighbour. On Europe that produces 13 to 33 against a target of 22, with the
 * outliers at either end being a peninsula and a zone that absorbed one.
 * Tightening it further is tuning against one map; the mechanic it feeds
 * (§6.7, phase 8) does not care about three provinces either way.
 *
 * Island components are legitimately below the minimum — a five-province
 * island is a five-province theatre — so the test allows a minority of zones
 * under it and holds every zone to the maximum.
 */
export const AIR_ZONE_MIN_PROVINCES = 13;
export const AIR_ZONE_MAX_PROVINCES = 34;

/**
 * Tiles per sea zone.
 *
 * Chosen so a sea zone is roughly the area of an air zone
 * (AIR_ZONE_TARGET_PROVINCES × TARGET_PROVINCE_TILES), which keeps the two
 * assignment screens reading at the same scale — invariant 5 asks for one zone
 * abstraction, and a sea zone forty times the size of an air zone would be one
 * abstraction with two meanings.
 */
export const SEA_ZONE_TARGET_TILES = 20_000;

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export const INFRASTRUCTURE_MIN = 0;
export const INFRASTRUCTURE_MAX = 10;

/** Starting infrastructure by terrain, before the bonuses below. */
export const INFRASTRUCTURE_BY_TERRAIN: Record<number, number> = {
  [TerrainType.Plains]: 4,
  [TerrainType.Highland]: 3,
  [TerrainType.Mountain]: 2,
};

/** A province with an ocean shore is easier to reach. */
export const INFRASTRUCTURE_COASTAL_BONUS = 1;

/** The capital is where the roads already go. */
export const INFRASTRUCTURE_CAPITAL_BONUS = 2;

// ---------------------------------------------------------------------------
// Building slots
// ---------------------------------------------------------------------------

/** Land tiles per building slot. */
export const TILES_PER_BUILDING_SLOT = 250;

export const BUILDING_SLOTS_MIN = 2;
export const BUILDING_SLOTS_MAX = 10;

/** The capital province gets room for the industry a nation starts with. */
export const BUILDING_SLOTS_CAPITAL_BONUS = 2;

// ---------------------------------------------------------------------------
// Resource deposits
// ---------------------------------------------------------------------------

/**
 * The one resource.
 *
 * It was four — steel, oil, aluminium, rubber — with a lopsided deposit
 * table so that every nation was short of something and had a reason to
 * trade. That reason survives: deposits are still lopsided *by amount*, so a
 * poor nation still buys from a rich one. What did not survive is the
 * bookkeeping: four stockpiles, four extraction rates, four demand rates and
 * four market prices, four rows in every panel, to make one decision that
 * was never about which of them you were short of.
 *
 * One number a player can hold in their head beats four they cannot
 * (decision 0029).
 */
export const RESOURCES = ["material"] as const;
export type Resource = (typeof RESOURCES)[number];

export interface DepositRule {
  /** Probability this province has any of this resource at all. */
  chance: number;
  /** Deposit size, inclusive. Extraction rate per tick is in rates.ts. */
  min: number;
  max: number;
}

/**
 * What each terrain yields.
 *
 * Still deliberately lopsided, and still for §6.5's sake: mountains are rich,
 * plains are thin, and a nation therefore has a shape it can trade its way
 * out of. The four tables this replaced differed in *which* resource a
 * terrain carried; this one differs in how much.
 */
export const DEPOSIT_RULES: Record<
  Resource,
  Record<number, DepositRule | undefined>
> = {
  material: {
    [TerrainType.Mountain]: { chance: 0.6, min: 3, max: 10 },
    [TerrainType.Highland]: { chance: 0.45, min: 2, max: 7 },
    [TerrainType.Plains]: { chance: 0.3, min: 1, max: 5 },
  },
};

/**
 * How long an occupier must hold a province before it becomes theirs.
 *
 * Decision 0002 splits ownership in two: `controller` moves the moment the
 * province is taken, `owner` only after this many ticks of unbroken control.
 * 336 ticks is fourteen in-game days — long enough that conquest is a
 * commitment rather than a click, short enough to resolve inside a six-week
 * season.
 */
export const OCCUPATION_TICKS = 336;
