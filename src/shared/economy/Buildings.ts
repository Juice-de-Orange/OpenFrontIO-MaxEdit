/**
 * What can be built, what it costs, and what it does.
 *
 * In `shared/` because the client needs the same numbers to show a build menu
 * — CLAUDE.md §3: shared holds pure functions and constants both sides use for
 * display. The server never trusts a client-computed value; it computes the
 * same cost itself and the client's copy is decoration.
 *
 * The list is CLAUDE.md §6.1's, in full, including the four that do nothing
 * until phases 6 to 9. They are buildable now because a building slot is a
 * scarce resource from the first tick, and a player who fills every slot with
 * factories in week one and then finds there is nowhere to put a supply hub
 * has been misled by the UI rather than by the game.
 */

export const BUILDING_TYPES = [
  "civilian_factory",
  "military_factory",
  "dockyard",
  "air_base",
  "naval_base",
  "supply_hub",
  "infrastructure",
  "extraction_upgrade",
] as const;

export type BuildingType = (typeof BUILDING_TYPES)[number];

/**
 * Index into the per-province building array.
 *
 * Stable, because it is in every snapshot: adding a type appends to the end of
 * BUILDING_TYPES, never inserts. Reordering the list silently reinterprets
 * every world already in progress.
 */
export function buildingIndex(type: BuildingType): number {
  return BUILDING_TYPES.indexOf(type);
}

export interface BuildingSpec {
  /** Construction points to finish one. Paid over many ticks (invariant 1). */
  cost: number;
  /**
   * Whether it occupies one of the province's building slots.
   *
   * Infrastructure and extraction upgrades do not: they raise a level on the
   * province itself. A nation that had to spend a slot to build a road would
   * never build one.
   */
  takesSlot: boolean;
  /** Only in a province with an ocean coastline. */
  coastalOnly: boolean;
  /** How many can exist in one province, for the levelled ones. */
  maxPerProvince?: number;
}

/**
 * Costs are deliberately low-ish and will be retuned. A nation starts with
 * three civilian factories, so a civilian factory is about ten in-game days of
 * a young nation's whole output — long enough that the choice matters, short
 * enough to see happen inside a session.
 */
export const BUILDINGS: Record<BuildingType, BuildingSpec> = {
  civilian_factory: { cost: 360, takesSlot: true, coastalOnly: false },
  military_factory: { cost: 300, takesSlot: true, coastalOnly: false },
  dockyard: { cost: 300, takesSlot: true, coastalOnly: true },
  air_base: { cost: 250, takesSlot: true, coastalOnly: false },
  naval_base: { cost: 250, takesSlot: true, coastalOnly: true },
  supply_hub: { cost: 150, takesSlot: true, coastalOnly: false },
  infrastructure: {
    cost: 200,
    takesSlot: false,
    coastalOnly: false,
    // The artefact caps a province's infrastructure at 10; construction can
    // take it the rest of the way there but no further.
    maxPerProvince: 10,
  },
  extraction_upgrade: {
    cost: 240,
    takesSlot: false,
    coastalOnly: false,
    maxPerProvince: 5,
  },
};
