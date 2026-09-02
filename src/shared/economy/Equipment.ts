/**
 * What a production line can make, and what it costs to make it.
 *
 * CLAUDE.md §6.3's list, in full. Units are never built directly: a line
 * deposits equipment into a national stockpile, and divisions, wings and
 * fleets draw from it to reach full strength. That indirection is the whole
 * point — it is what makes the economy *felt* rather than watched, because a
 * lost battle is a hole in the stockpile that the factories then have to fill
 * again.
 *
 * **Three, where §6.3 listed ten** (decision 0030). One kind of thing per
 * kind of unit: an army eats `infantry`, a wing eats `aircraft`, a fleet
 * eats `ships`. The ten were a shopping list a player had to learn before
 * they could open a production line, and the strategy they carried — rifles
 * *and* guns, or the division fights at the worse ratio — was a lesson in
 * bookkeeping rather than in war.
 *
 * `ships` is the merchant marine as well as the navy, which is what keeps
 * §6.3's best idea: sea supply and seaborne trade consume ships, and enemy
 * raiding sinks them, so losing a naval war still shows up as a number in
 * the economy screen — and now it is the *same* number that makes your
 * fleets weaker.
 *
 * In `shared/` because the build menu needs the same costs the server uses.
 * The server computes them again; the client's copy is decoration (§7).
 */

export const EQUIPMENT_TYPES = ["infantry", "aircraft", "ships"] as const;

export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

/**
 * Index into the per-nation stockpile array.
 *
 * Stable, because it is in every snapshot: adding a type appends to the end of
 * EQUIPMENT_TYPES, never inserts. Reordering the list silently reinterprets
 * every world already in progress — the same rule as `BUILDING_TYPES`.
 */
export function equipmentIndex(type: EquipmentType): number {
  return EQUIPMENT_TYPES.indexOf(type);
}

/**
 * Which kind of factory can build it.
 *
 * One kind (decision 0032). §6.1 gave dockyards their own building because
 * naval equipment was four of the ten types and coastal industry was a real
 * constraint; with one naval good and a naval base already deciding where a
 * fleet can be raised, a second factory type was a second thing to build
 * before you could build the thing.
 */
export type Yard = "military_factory";

export interface EquipmentSpec {
  /**
   * Industrial output points for one unit of it.
   *
   * A military factory makes `MILITARY_FACTORY_OUTPUT` points a tick, so a
   * single factory at full efficiency turns out about one rifle-equivalent
   * every two and a half ticks and one capital ship every eight in-game days.
   */
  cost: number;
  yard: Yard;
}

export const EQUIPMENT: Record<EquipmentType, EquipmentSpec> = {
  infantry: { cost: 1, yard: "military_factory" },
  aircraft: { cost: 8, yard: "military_factory" },
  ships: { cost: 12, yard: "military_factory" },
};

/**
 * What one division is at full strength.
 *
 * Fixed, and deliberately so. CLAUDE.md §10 excludes division templates and
 * equipment designers: they add a design minigame that interacts with nothing
 * else on the list. A division is a division, and the only thing that varies
 * about it is how much of this it actually has.
 */
export const DIVISION_TEMPLATE: Partial<Record<EquipmentType, number>> = {
  infantry: 100,
};
