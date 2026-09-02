/**
 * Every per-tick rate in the economy, in one file.
 *
 * CLAUDE.md §4: how fast the world feels is set here and nowhere else. The
 * tick rate is a resolution choice, not a speed choice — retune these, never
 * `TICK_MS`.
 *
 * **Deliberately low.** A season is six weeks; one in-game day is two minutes
 * of wall clock. These are the first numbers anyone will want to change, and
 * they are all in one place so that changing them is a diff and not a hunt.
 *
 * Per invariant 9, nothing here is ever shown to a player as written: the UI
 * multiplies by `TICKS_PER_DAY` and says "per day".
 */

import type { EquipmentType } from "../economy/Equipment";
import type { Resource } from "./provinces";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Resource units per tick, per point of deposit.
 *
 * A province with a deposit of 5 yields 0.25 a tick, six a day. Europe has 261
 * provinces with a deposit between them, so a mid-sized nation runs a handful.
 */
export const EXTRACTION_PER_DEPOSIT = 0.05;

/** Each extraction upgrade adds this share of the base yield. */
export const EXTRACTION_UPGRADE_BONUS = 0.25;

/**
 * What an occupied province yields to whoever is holding it.
 *
 * CLAUDE.md §10 lists "whether occupied provinces produce at reduced rate or
 * not at all" as open. Reduced: nothing in this game hard-blocks (invariant
 * 2), and a conquest that produced nothing at all would make holding ground
 * worthless for the fortnight before the ownership transfers — which is
 * exactly the period decision 0002 exists to make interesting.
 */
export const OCCUPIED_OUTPUT_FACTOR = 0.4;

/** Infrastructure's effect on extraction, per level above zero. */
export const INFRASTRUCTURE_EXTRACTION_BONUS = 0.04;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** Construction points one civilian factory produces per tick. */
export const CIVILIAN_FACTORY_OUTPUT = 0.5;

/**
 * Industrial output one military factory or dockyard produces per tick.
 *
 * Phase 4 turns this into equipment through production lines and the
 * efficiency ramp (§6.2). Until then it is a number the economy screen shows,
 * and it is what a resource shortage is visibly measured against.
 */
export const MILITARY_FACTORY_OUTPUT = 0.4;
export const DOCKYARD_OUTPUT = 0.4;

/**
 * What a military factory or dockyard draws per tick with **no line to work on**.
 *
 * §5: resources are consumed by military factories, dockyards, and units in
 * the field. Civilian factories draw nothing — construction points are labour,
 * not steel — which is also why a nation that has lost its mines can still
 * build its way back.
 *
 * Since phase 4 this is the *idle* rate: a factory assigned to a production
 * line draws `EQUIPMENT_MATERIALS` for whatever that line makes instead. An
 * idle factory is not free, and is priced at about what the cheapest line
 * costs — see docs/decisions/0009 for why, and for what it protects.
 */
export const MILITARY_FACTORY_DEMAND: Partial<Record<Resource, number>> = {
  steel: 0.2,
  aluminium: 0.04,
};

export const DOCKYARD_DEMAND: Partial<Record<Resource, number>> = {
  steel: 0.25,
  rubber: 0.03,
};

/**
 * What a factory draws per tick for the *thing it is making*.
 *
 * The two rates above are what an **unassigned** factory draws: a plant kept
 * tooled and staffed, ready for a line, is not a plant that costs nothing. A
 * factory that is on a production line draws this instead, by equipment type,
 * so that choosing what to build is an economic decision and not only an
 * industrial one — a tank line and a rifle line of the same size are not the
 * same drain on the same mines.
 *
 * Read per factory per tick, exactly like the flat rates, and **not** scaled
 * by the equipment's `cost`: a heavy type is slow to come off the line *and*
 * expensive to feed, and multiplying the two would make armour cost fifty
 * times what a rifle does rather than three.
 *
 * The cheapest line costs about what an idle factory costs, which is the
 * anchor the whole table is hung on. That is what keeps the flat rates
 * meaningful — and it is what keeps the phase-3 gate, which builds nothing but
 * unassigned factories and measures exactly that flat draw, measuring the same
 * thing it did before this table existed. See docs/decisions/0009.
 */
export const EQUIPMENT_MATERIALS: Record<
  EquipmentType,
  Partial<Record<Resource, number>>
> = {
  infantry_equipment: { steel: 0.2, aluminium: 0.02 },
  artillery: { steel: 0.3, aluminium: 0.04 },
  armour: { steel: 0.55, rubber: 0.06, oil: 0.05 },
  fighter: { steel: 0.15, aluminium: 0.3 },
  bomber: { steel: 0.2, aluminium: 0.4 },
  transport: { steel: 0.25, rubber: 0.07 },
  convoy: { steel: 0.25 },
  submarine: { steel: 0.4, oil: 0.06 },
  escort: { steel: 0.35, aluminium: 0.05 },
  capital_ship: { steel: 0.65, aluminium: 0.08, oil: 0.05 },
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * How many queue entries take construction points at once.
 *
 * One. Splitting the flow across the queue is the obvious alternative and it
 * makes every project finish late; a queue that finishes its front item is a
 * queue a player can plan against.
 */
export const CONSTRUCTION_PARALLEL_ITEMS = 1;

/** Infrastructure's effect on construction speed in that province, per level. */
export const INFRASTRUCTURE_CONSTRUCTION_BONUS = 0.03;

// ---------------------------------------------------------------------------
// Production lines (§6.2)
// ---------------------------------------------------------------------------

/**
 * The efficiency floor and cap of a production line.
 *
 * A line starts at the floor, climbs while it runs, and is knocked back to the
 * floor whenever its equipment type changes. This is the mechanic the whole
 * game's pace rests on (§6.2): a player who commits to producing one thing for
 * a long time massively out-produces one who reacts constantly.
 */
export const EFFICIENCY_FLOOR = 0.1;
export const EFFICIENCY_CAP = 1;

/**
 * How much efficiency a line gains per tick it runs uninterrupted.
 *
 * From floor to cap in 900 ticks — a bit under 38 in-game days, or an hour and
 * a quarter of wall clock. Long enough that switching hurts for a week of
 * play, short enough that a committed line pays off inside a six-week season.
 */
export const EFFICIENCY_GAIN = 0.001;

/**
 * Efficiency lost per tick by a line with no factories on it.
 *
 * Slower than the gain, so a line briefly stripped to move factories elsewhere
 * is not ruined — but a line left idle for a season does not keep the
 * efficiency it earned. Adding or removing factories never resets it (§6.2);
 * only switching the equipment type does.
 */
export const EFFICIENCY_DECAY = 0.0004;

// ---------------------------------------------------------------------------
// Manpower and divisions
// ---------------------------------------------------------------------------

/**
 * Manpower a province contributes to its owner's cap, per land tile.
 *
 * CLAUDE.md §10 leaves the manpower model open between conscription laws and a
 * simple population-scaled cap. This is the second — see
 * docs/decisions/0008. Conscription laws would need political power or
 * stability to be gated by, and §10 excludes the politics layer that would
 * gate them, so they would be a free lunch.
 */
export const MANPOWER_PER_TILE = 0.6;

/** Manpower regained per tick, as a share of the nation's cap. */
export const MANPOWER_REGROWTH = 0.0002;

/** What raising one division costs, and what a full-strength one holds. */
export const DIVISION_MANPOWER = 1000;

/**
 * How much of its equipment a division takes from the stockpile per tick.
 *
 * A fraction of what it is still short of, so a division fills up quickly at
 * first and then tails off — and so a stockpile with several divisions drawing
 * on it is shared out rather than emptied by whichever one asked first.
 */
export const DIVISION_REINFORCE_RATE = 0.02;

// ---------------------------------------------------------------------------
// The border clash
// ---------------------------------------------------------------------------

/**
 * What one clash destroys, as a share of what the divisions there are holding.
 *
 * The defender loses more: it is the one being pushed out of the province.
 * Both numbers are small on purpose — a front that grinds for in-game weeks is
 * the shape this game wants, and a single tick should be a scratch. What makes
 * it felt is that it happens every tick, for as long as the war lasts.
 */
export const COMBAT_DEFENDER_LOSS = 0.08;
export const COMBAT_ATTACKER_LOSS = 0.05;

// ---------------------------------------------------------------------------
// What a nation starts with
// ---------------------------------------------------------------------------

/** Buildings placed in each nation's capital province at tick 0. */
export const STARTING_CAPITAL_BUILDINGS = {
  civilian_factory: 3,
  military_factory: 1,
} as const;

/**
 * The opening stockpile.
 *
 * Enough to run the starting factories for a few in-game days, so a nation
 * that ignores its economy entirely feels it inside the first session rather
 * than in week three.
 */
export const STARTING_RESOURCES: Record<Resource, number> = {
  steel: 200,
  oil: 100,
  aluminium: 100,
  rubber: 50,
};

/**
 * The most of one resource a nation can hold.
 *
 * A cap rather than a warehouse mechanic: without it, a nation that is offline
 * for a week returns to an unspendable pile and the shortage system it was
 * meant to feel never engages again.
 */
export const RESOURCE_CAP = 5000;

/** And the same for one equipment type. */
export const EQUIPMENT_CAP = 100_000;
