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
 * `convoy` is in here rather than among the units for the same reason (§6.3):
 * sea supply and seaborne trade consume it, and enemy raiding sinks it, so
 * losing a naval war shows up as a number in the economy screen.
 *
 * In `shared/` because the build menu needs the same costs the server uses.
 * The server computes them again; the client's copy is decoration (§7).
 */

export const EQUIPMENT_TYPES = [
  "infantry_equipment",
  "artillery",
  "armour",
  "fighter",
  "bomber",
  "transport",
  "convoy",
  "submarine",
  "escort",
  "capital_ship",
] as const;

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

/** Which kind of factory can build it. §6.1: dockyards make naval equipment. */
export type Yard = "military_factory" | "dockyard";

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
  infantry_equipment: { cost: 1, yard: "military_factory" },
  artillery: { cost: 4, yard: "military_factory" },
  armour: { cost: 12, yard: "military_factory" },
  fighter: { cost: 8, yard: "military_factory" },
  bomber: { cost: 14, yard: "military_factory" },
  transport: { cost: 6, yard: "military_factory" },
  convoy: { cost: 3, yard: "dockyard" },
  submarine: { cost: 20, yard: "dockyard" },
  escort: { cost: 12, yard: "dockyard" },
  capital_ship: { cost: 80, yard: "dockyard" },
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
  infantry_equipment: 100,
  artillery: 12,
};
