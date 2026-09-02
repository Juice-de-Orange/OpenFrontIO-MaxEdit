/**
 * Canonical unit type string constants.
 *
 * These match the strings the upstream game sends in UnitEventUpdate.unitType.
 * Use these instead of raw string literals to prevent typos and enable
 * find-all-references.
 */

// ---------------------------------------------------------------------------
// Individual unit type constants
// ---------------------------------------------------------------------------

// Mobile units
export const UT_TRANSPORT = "Transport" as const;
export const UT_TRADE_SHIP = "Trade Ship" as const;
export const UT_WARSHIP = "Warship" as const;
export const UT_ATOM_BOMB = "Atom Bomb" as const;
export const UT_HYDROGEN_BOMB = "Hydrogen Bomb" as const;
export const UT_MIRV = "MIRV" as const;
export const UT_SAM_MISSILE = "SAMMissile" as const;
export const UT_SHELL = "Shell" as const;
export const UT_MIRV_WARHEAD = "MIRV Warhead" as const;
export const UT_TRAIN = "Train" as const;

// Structures
export const UT_CITY = "City" as const;
export const UT_PORT = "Port" as const;
export const UT_FACTORY = "Factory" as const;
export const UT_DEFENSE_POST = "Defense Post" as const;
export const UT_SAM_LAUNCHER = "SAM Launcher" as const;
export const UT_MISSILE_SILO = "Missile Silo" as const;

// This fork's buildings (CLAUDE.md §6.1). Columns 6–12 of the atlas, drawn by
// `scripts/generate-structure-atlas.mjs` from `resources/images/structures/`.
// The two synthetic refineries share one icon: they are the same building
// with two outputs.
export const UT_CIVILIAN_FACTORY = "Civilian Factory" as const;
export const UT_MILITARY_FACTORY = "Military Factory" as const;
export const UT_DOCKYARD = "Dockyard" as const;
export const UT_REFINERY = "Refinery" as const;
export const UT_AIR_BASE = "Air Base" as const;
export const UT_NAVAL_BASE = "Naval Base" as const;
export const UT_SUPPLY_HUB = "Supply Hub" as const;

// ---------------------------------------------------------------------------
// Derived sets
// ---------------------------------------------------------------------------

/**
 * Structure types in atlas column order — index = column in
 * `resources/atlases/icon-atlas.png`. One list, read by StructurePass,
 * StructureLevelPass and the cosmetics preview; it used to be copied into
 * each with a "must match" comment. Append, never reorder: the atlas is a
 * checked-in artefact and its columns do not move.
 */
export const STRUCTURE_ORDER = [
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_CIVILIAN_FACTORY,
  UT_MILITARY_FACTORY,
  UT_DOCKYARD,
  UT_REFINERY,
  UT_AIR_BASE,
  UT_NAVAL_BASE,
  UT_SUPPLY_HUB,
] as const;

export type StructureType = (typeof STRUCTURE_ORDER)[number];

/**
 * The plate a structure's icon sits on. Numbered as the structure shader's
 * `shapeSDF` reads them; the six inherited entries keep the shape their
 * column index used to imply.
 */
export const SHAPE_CIRCLE = 0;
export const SHAPE_PENTAGON = 1;
export const SHAPE_HEXAGON = 2;
export const SHAPE_OCTAGON = 3;
export const SHAPE_SQUARE = 4;
export const SHAPE_TRIANGLE = 5;

export const STRUCTURE_SHAPE: Readonly<Record<StructureType, number>> = {
  [UT_CITY]: SHAPE_CIRCLE,
  [UT_PORT]: SHAPE_PENTAGON,
  [UT_FACTORY]: SHAPE_HEXAGON,
  [UT_DEFENSE_POST]: SHAPE_OCTAGON,
  [UT_SAM_LAUNCHER]: SHAPE_SQUARE,
  [UT_MISSILE_SILO]: SHAPE_TRIANGLE,
  [UT_CIVILIAN_FACTORY]: SHAPE_CIRCLE,
  [UT_MILITARY_FACTORY]: SHAPE_HEXAGON,
  [UT_DOCKYARD]: SHAPE_PENTAGON,
  [UT_REFINERY]: SHAPE_OCTAGON,
  [UT_AIR_BASE]: SHAPE_SQUARE,
  [UT_NAVAL_BASE]: SHAPE_PENTAGON,
  [UT_SUPPLY_HUB]: SHAPE_TRIANGLE,
};

export const STRUCTURE_TYPES: ReadonlySet<string> = new Set(STRUCTURE_ORDER);

export const NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
]);

/** Nuke types whose rendered position is interpolated lastPos→pos each render
 *  frame (UnitPass). Their trails stamp only up to lastPos so the tail never
 *  leads the smoothly-moving missile. */
export const SMOOTHED_NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
]);

/** Blast radii (in tiles) matching upstream DefaultConfig.nukeMagnitudes(). */
export const NUKE_MAGNITUDES: Readonly<
  Record<string, { inner: number; outer: number }>
> = {
  [UT_ATOM_BOMB]: { inner: 12, outer: 30 },
  [UT_HYDROGEN_BOMB]: { inner: 80, outer: 100 },
  [UT_MIRV_WARHEAD]: { inner: 12, outer: 18 },
};

// ---------------------------------------------------------------------------
// Ordered lists (atlas column order — used by GPU passes + header)
// ---------------------------------------------------------------------------

/** All unit type strings in the canonical order used by RendererConfig.unitTypes. */
export const ALL_UNIT_TYPES = [
  UT_TRANSPORT,
  UT_TRADE_SHIP,
  UT_WARSHIP,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_MIRV_WARHEAD,
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_TRAIN,
  UT_CIVILIAN_FACTORY,
  UT_MILITARY_FACTORY,
  UT_DOCKYARD,
  UT_REFINERY,
  UT_AIR_BASE,
  UT_NAVAL_BASE,
  UT_SUPPLY_HUB,
] as const;
