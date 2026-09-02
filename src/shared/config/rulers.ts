/**
 * Names for the heads of state the regent plays as.
 *
 * Fifty-one of the fifty-two nations are played by their regent for most of a
 * season, and a nation with a name and a flag but nobody at the top reads as
 * a spreadsheet row. A ruler's name is the cheapest personality there is.
 *
 * **Derived, never stored** (docs/decisions/0023): `rulerName(worldSeed,
 * smallID)` is a pure function, so the name lives in no snapshot and moves no
 * state hash — a deploy that adds a name to every nation must not end the
 * season that is running. The nation list is rebuilt from the manifest on
 * every start, and the derivation reproduces it exactly.
 *
 * The lists are deliberately pan-European and deliberately not matched to a
 * nation: a name that "sounds right" for one country is a stereotype for the
 * next, and the map has fifty-two of them. Two lists of forty give sixteen
 * hundred combinations, enough that two nations sharing a name is rare and
 * harmless.
 */

import { PseudoRandom } from "../util/PseudoRandom";

const GIVEN = [
  "Adrian",
  "Agnes",
  "Alma",
  "Anselm",
  "Beata",
  "Bruno",
  "Casimir",
  "Clara",
  "Dagny",
  "Edvard",
  "Elin",
  "Emil",
  "Erzsébet",
  "Florian",
  "Greta",
  "Hugo",
  "Ilse",
  "Ines",
  "Ivo",
  "Jonas",
  "Katarina",
  "Konstantin",
  "Leonor",
  "Lovis",
  "Magda",
  "Marek",
  "Mathilde",
  "Nils",
  "Olga",
  "Oskar",
  "Paula",
  "Rasmus",
  "Rosalind",
  "Sander",
  "Sigrid",
  "Teodor",
  "Ulrika",
  "Viktor",
  "Wanda",
  "Zoran",
] as const;

const FAMILY = [
  "Adler",
  "Almeida",
  "Bergström",
  "Blažek",
  "Castellan",
  "Dubois",
  "Egede",
  "Falk",
  "Ferrante",
  "Gallo",
  "Halvorsen",
  "Horváth",
  "Iversen",
  "Jansen",
  "Kowalczyk",
  "Lindqvist",
  "Marais",
  "Moreau",
  "Novak",
  "Oliveira",
  "Petrescu",
  "Quist",
  "Rademaker",
  "Ristić",
  "Salomon",
  "Schreiber",
  "Sørlie",
  "Tamm",
  "Toussaint",
  "Ulmer",
  "Valdés",
  "Varga",
  "Verhoeven",
  "Weiss",
  "Wójcik",
  "Ybarra",
  "Zeman",
  "Ziegler",
  "Åkesson",
  "Østergaard",
] as const;

/** The ruler of a nation, for this world. Pure: same seed and id, same name. */
export function rulerName(worldSeed: number, smallID: number): string {
  // The house mixing idiom (combat.ts): the seed against a golden-ratio
  // multiple of the context id, so neighbouring ids do not draw neighbours.
  const random = new PseudoRandom(
    (worldSeed ^ Math.imul(smallID, 0x9e3779b1)) >>> 0,
  );
  const given = GIVEN[Math.floor(random.next() * GIVEN.length)];
  const family = FAMILY[Math.floor(random.next() * FAMILY.length)];
  return `${given} ${family}`;
}
