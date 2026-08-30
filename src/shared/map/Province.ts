/**
 * What a province *is*, as opposed to what is happening to it.
 *
 * CLAUDE.md §5 gives one `Province` interface carrying both — geography and
 * ownership together. This file holds only the geography, and that split is
 * deliberate:
 *
 * - **The geography is map data.** It is derived once by the generator, checked
 *   into the repository next to the terrain bytes, and identical on every
 *   world that runs on that map. It never appears in a snapshot, never travels
 *   on the wire, and never changes while a season is running.
 * - **The ownership is world state.** `owner` and `controller` live in
 *   `server/world/World.ts`, are in every snapshot, and move every tick
 *   (docs/decisions/0002).
 *
 * Keeping them in one object would have put four megabytes of static map data
 * into every snapshot to carry eight hundred numbers that actually change.
 *
 * `tiles` from the specification's interface is also absent here. It lives in
 * the tile -> province array in the artefact, and is inverted into a CSR index
 * (`client/world/ProvinceTileIndex.ts`) by whoever needs it. A province on
 * Europe holds ~900 tiles; nine hundred provinces holding their own arrays is
 * the same four megabytes again, in the most fragmented form available.
 */

import type { Resource } from "../config/provinces";
import type { TerrainType } from "./Terrain";

export type ProvinceId = number;
export type ZoneId = number;

/** 1-based, matching the renderer's palette slots. 0 means unowned. */
export type NationId = number;

export interface Province {
  id: ProvinceId;

  /**
   * The nation this province was cut out of when the map was partitioned.
   *
   * A starting position, not a claim: the world's `owner` array begins here
   * and moves on from tick 1. It is kept because a province has to remember
   * where it came from — the capital bonus, the nation's starting borders, and
   * anything later that wants to know whose land this historically was.
   */
  nation: NationId;

  /** Provinces sharing a border, ascending. */
  neighbours: ProvinceId[];

  airZone: ZoneId;

  /** The adjacent sea zone, or null for a landlocked province. */
  seaZone: ZoneId | null;

  /** Majority terrain of this province's land tiles. */
  terrain: TerrainType;

  /** 0..10. Raises supply throughput and construction speed. */
  infrastructure: number;

  buildingSlots: number;

  /** Only the resources this province actually has. */
  resourceDeposits: Partial<Record<Resource, number>>;

  /** Land tiles. Rendering reads the tile array; this is for the UI and tests. */
  tileCount: number;

  /** Tile-space centre of mass, for labels and camera moves. */
  centre: { x: number; y: number };

  /** Has at least one tile on an ocean shore. Dockyards and naval bases need it. */
  coastal: boolean;

  /** Holds its nation's starting capital. */
  capital: boolean;
}
