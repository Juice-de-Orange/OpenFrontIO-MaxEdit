/**
 * Every ruler has a temperament, and it is what makes fifty-one regents
 * fifty-one different opponents rather than one steward in fifty-one colours.
 *
 * Six axes, each 0.2 to 1: how much of the regent's attention the war, the
 * walls, the factories, the sea, the sky and the laboratories get. One of
 * them is dominant — lifted to at least `DOMINANT` — so the tendency is
 * legible, and the dominant axis names the archetype the other players see
 * beside the ruler's name. Two high axes make a marshal: the defender who
 * strikes.
 *
 * **Derived, never stored** (decisions 0023 and 0028): `temperamentOf` is a
 * pure function of the world seed and the nation, like the ruler's name, so
 * it lives in no snapshot and moves no hash. A nation with no coast has no
 * sea to care about — its `naval` axis is floored before the draw decides,
 * because an admiral without a harbour would be a joke.
 *
 * The regent reads the axes (`systems/regent/`); the season's opening reads
 * the archetype for the focus it hands an unclaimed nation (`Season.ts`).
 */

import type { Province } from "../map/Province";
import { PseudoRandom } from "../util/PseudoRandom";
import type { RegentFocus } from "./regent";

export const ARCHETYPES = [
  "builder",
  "warden",
  "marshal",
  "admiral",
  "airman",
  "scholar",
  "conqueror",
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export interface Temperament {
  /** Wars started and fronts held open. */
  aggression: number;
  /** Garrisons kept, hubs built early, retreats called soon. */
  caution: number;
  /** Civilian factories, roads and mines before guns. */
  industry: number;
  /** Dockyards, convoys, escorts — and submarines, when aggressive too. */
  naval: number;
  /** Air bases, fighters over the home zone, bombers over the enemy's. */
  air: number;
  /** Which techs come first. */
  science: number;
  archetype: Archetype;
}

/** The floor of every axis, and where a landlocked nation's `naval` stays. */
export const AXIS_FLOOR = 0.2;
/** Where the dominant axis is lifted to, so a tendency is a tendency. */
export const DOMINANT = 0.85;
/** Both `aggression` and `caution` at or above this make a marshal. */
export const MARSHAL_ABOVE = 0.6;

const AXES = [
  "aggression",
  "caution",
  "industry",
  "naval",
  "air",
  "science",
] as const;
type Axis = (typeof AXES)[number];

const ARCHETYPE_OF_AXIS: Readonly<Record<Axis, Archetype>> = {
  aggression: "conqueror",
  caution: "warden",
  industry: "builder",
  naval: "admiral",
  air: "airman",
  science: "scholar",
};

/** Whether a nation was cut out of the map with a coast. */
export function nationIsCoastal(
  map: { provinces: readonly Province[] },
  nation: number,
): boolean {
  return map.provinces.some(
    (province) => province.nation === nation && province.coastal,
  );
}

/** A ruler's temperament, for this world. Pure: same seed and id, same ruler. */
export function temperamentOf(
  worldSeed: number,
  nation: number,
  coastal: boolean,
): Temperament {
  // A salt of its own, so the temperament says nothing about the name drawn
  // from the same seed (rulers.ts) or the focus (Season.ts).
  const random = new PseudoRandom(
    (worldSeed ^ Math.imul(nation, 0x7feb352d) ^ 0x1e55) >>> 0,
  );
  const axes: Record<Axis, number> = {
    aggression: 0,
    caution: 0,
    industry: 0,
    naval: 0,
    air: 0,
    science: 0,
  };
  for (const axis of AXES) {
    axes[axis] = AXIS_FLOOR + (1 - AXIS_FLOOR) * 0.75 * random.next();
  }
  if (!coastal) axes.naval = AXIS_FLOOR;

  let archetype: Archetype;
  if (axes.aggression >= MARSHAL_ABOVE && axes.caution >= MARSHAL_ABOVE) {
    archetype = "marshal";
    axes.aggression = Math.max(axes.aggression, 0.75);
    axes.caution = Math.max(axes.caution, 0.75);
  } else {
    let dominant: Axis = "industry";
    for (const axis of AXES) {
      if (axes[axis] > axes[dominant]) dominant = axis;
    }
    axes[dominant] = Math.max(axes[dominant], DOMINANT);
    archetype = ARCHETYPE_OF_AXIS[dominant];
  }
  return { ...axes, archetype };
}

/**
 * The focus a regent opens the season with, from its archetype (decision
 * 0028). The player's focus is the player's; this is for nations nobody
 * holds. Conquerors expand, wardens defend, the three service chiefs arm,
 * and builders and scholars build.
 */
export function focusForArchetype(archetype: Archetype): RegentFocus {
  switch (archetype) {
    case "conqueror":
      return "expansion";
    case "warden":
      return "defence";
    case "marshal":
    case "airman":
    case "admiral":
      return "military";
    case "builder":
    case "scholar":
      return "economy";
  }
}
