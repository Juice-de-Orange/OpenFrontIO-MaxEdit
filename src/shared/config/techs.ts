/**
 * The tech list, flat, with prerequisites and flat modifiers.
 *
 * CLAUDE.md §6.4 is unusually blunt about this system: it is the cheapest one
 * in the whole plan and it is to stay that way. **No focus tree. No doctrine
 * tree.** A flat list with prerequisites is enough, and every attempt to make
 * research interesting in its own right takes interest away from the systems
 * research is supposed to modify.
 *
 * So each tech is three things and nothing else: how long it takes, what it
 * needs first, and which number it moves. There is no cost in resources — a
 * slot is the cost, and a nation has two of them.
 *
 * **Every modifier here has to land on a number that already exists.** A tech
 * that grants "+10% supply range" before phase 6 has built supply is a tech
 * that does nothing and cannot be told apart from a bug, so the list grows
 * with the phases rather than ahead of them.
 */

/**
 * Four, flat, no prerequisites (decision 0032).
 *
 * §6.4 already said this system should be the cheapest thing in the game and
 * should stay that way. Ten techs behind a dependency graph was a small
 * tree pretending not to be one, and nine of the ten were a percentage on a
 * number the player was not watching. These four each change something a
 * player can see happen: what a factory turns out, how fast an army fills,
 * how much a defended province costs to take, and how many things you can
 * research at once.
 */
export const TECH_IDS = [
  "machine_tools",
  "field_workshops",
  "entrenchment",
  "research_bureau",
] as const;

export type TechId = (typeof TECH_IDS)[number];

/**
 * What a tech changes, as shares of the base rate unless said otherwise.
 *
 * Summed across everything a nation has unlocked and applied once, so two
 * +10% techs are +20% rather than +21%. Compounding is the more realistic
 * rule and the less readable one: a player should be able to add the numbers
 * on the screen and get the number on the screen.
 */
export interface TechEffect {
  /** Share added to what a military factory or dockyard turns out. */
  factoryOutput?: number;
  /** Points added to the production-line efficiency cap. Absolute, not a share. */
  efficiencyCap?: number;
  /** Share added to every province's extraction. */
  extraction?: number;
  /** Share added to construction points. */
  construction?: number;
  /** Extra research slots. Absolute. */
  researchSlots?: number;
  /** Share added to how fast a division draws replacements. */
  reinforceRate?: number;
  /** Share added to what a clash destroys — negative is the useful direction. */
  defenderLoss?: number;
}

export interface Tech {
  /** Techs that must be finished first. */
  requires: readonly TechId[];
  /** Ticks of one slot's undivided attention. */
  ticks: number;
  effect: TechEffect;
}

/**
 * Durations are in ticks, and a tick is an in-game hour: 480 ticks is twenty
 * in-game days, or forty minutes of wall clock. Deliberately long. Two slots
 * over a six-week season is perhaps a dozen techs, so the list is a set of
 * choices rather than a checklist to be completed.
 */
export const TECHS: Record<TechId, Tech> = {
  machine_tools: { requires: [], ticks: 480, effect: { factoryOutput: 0.15 } },
  field_workshops: { requires: [], ticks: 500, effect: { reinforceRate: 0.5 } },
  entrenchment: { requires: [], ticks: 600, effect: { defenderLoss: -0.25 } },
  research_bureau: { requires: [], ticks: 900, effect: { researchSlots: 1 } },
};

/** Slots a nation has before any tech adds one. §6.4: default 2, up to 4. */
export const RESEARCH_SLOTS = 2;
export const MAX_RESEARCH_SLOTS = 4;

/** Every effect, at zero. A nation with no techs reads exactly this. */
export type Modifiers = Required<TechEffect>;

const NONE: Modifiers = {
  factoryOutput: 0,
  efficiencyCap: 0,
  extraction: 0,
  construction: 0,
  researchSlots: 0,
  reinforceRate: 0,
  defenderLoss: 0,
};

/**
 * Fold a nation's unlocked techs into one set of numbers.
 *
 * Pure, cheap, and called wherever a rate is read rather than cached on the
 * nation. A cached copy is a second source of truth that a restore has to keep
 * in step, and the fold is nine additions.
 */
export function modifiersOf(unlocked: readonly TechId[]): Modifiers {
  const total: Modifiers = { ...NONE };
  for (const id of unlocked) {
    const tech = TECHS[id];
    if (tech === undefined) continue;
    for (const key of Object.keys(NONE) as (keyof Modifiers)[]) {
      total[key] += tech.effect[key] ?? 0;
    }
  }
  return total;
}

/** How many slots this nation has, capped where §6.4 caps it. */
export function slotsFor(unlocked: readonly TechId[]): number {
  return Math.min(
    MAX_RESEARCH_SLOTS,
    RESEARCH_SLOTS + modifiersOf(unlocked).researchSlots,
  );
}

/** Whether every prerequisite is already in hand. */
export function isAvailable(id: TechId, unlocked: readonly TechId[]): boolean {
  if (unlocked.includes(id)) return false;
  return TECHS[id].requires.every((need) => unlocked.includes(need));
}
