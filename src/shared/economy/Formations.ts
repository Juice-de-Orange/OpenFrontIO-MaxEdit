/**
 * Wings and fleets: what goes into a zone, and what it is good at there.
 *
 * CLAUDE.md §6.7 and §6.8 describe two systems, and §6.8 says outright that
 * the second is **the same code** as the first with a different mission set.
 * So there is one entity here, not two. A `Formation` is whatever a player
 * assigns to a zone — a wing today, a fleet in phase 9 — and everything that
 * differs between air and sea is a row in a table in this file rather than a
 * branch in a system.
 *
 * Invariant 4 is why the entity is this coarse: *the player allocates, never
 * micromanages*. A formation goes to a zone with a mission and stays there.
 * There is no individual aircraft and no individual ship, here or anywhere.
 *
 * The equipment comes out of the same national stockpile divisions draw from
 * (§6.3), which is what ties an air war to the factories: a fighter lost over
 * a zone is a fighter the military factories have to make again, and every
 * hour they spend on it is an hour not spent on rifles.
 */

import type { EquipmentType } from "./Equipment";

/**
 * Which zoned system a formation belongs to.
 *
 * A province carries both an `airZone` and, if it is coastal, a `seaZone`, so
 * the kind is what picks which of the two a formation is assigned over.
 */
export const ZONE_KINDS = ["air", "naval"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/** §6.7's four, in full. */
export const AIR_MISSIONS = [
  "air_superiority",
  "ground_support",
  "interdiction",
  "strategic_bombing",
] as const;

/** §6.8's four, in full. Phase 9 resolves them; the machine is already here. */
export const NAVAL_MISSIONS = [
  "sea_control",
  "convoy_raiding",
  "convoy_escort",
  "invasion_support",
] as const;

export type AirMission = (typeof AIR_MISSIONS)[number];
export type NavalMission = (typeof NAVAL_MISSIONS)[number];
export type Mission = AirMission | NavalMission;

export const MISSIONS = [...AIR_MISSIONS, ...NAVAL_MISSIONS] as const;

/** Which missions a zone kind offers. The assignment UI reads this. */
export const MISSIONS_BY_KIND: Readonly<Record<ZoneKind, readonly Mission[]>> =
  {
    air: AIR_MISSIONS,
    naval: NAVAL_MISSIONS,
  } as const;

/**
 * The kinds of formation a player can raise.
 *
 * Fixed and short, for the reason §10 gives for excluding division designers:
 * a composition minigame interacts with nothing else on the list. What varies
 * about a wing is how much of its template it actually holds, exactly as with
 * a division.
 *
 * Appended to, never reordered — the id is in every snapshot.
 */
export const FORMATION_TEMPLATES = ["fighter_wing", "bomber_wing"] as const;

export type FormationTemplate = (typeof FORMATION_TEMPLATES)[number];

export function formationTemplateIndex(template: FormationTemplate): number {
  return FORMATION_TEMPLATES.indexOf(template);
}

export interface FormationSpec {
  /** Which zoned system it flies or sails in. */
  kind: ZoneKind;
  /** What it is at full strength, drawn from the national stockpile. */
  equipment: Partial<Record<EquipmentType, number>>;
  /** The building it has to be raised at, and is based out of. */
  base: "air_base" | "naval_base";
  /**
   * What it contributes to each mission, relative to its own strength.
   *
   * This table is the whole difference between a fighter and a bomber, and in
   * phase 9 it will be the whole difference between a submarine and a capital
   * ship (§6.8: "submarines are strong at convoy raiding and weak in a
   * stand-up fight; escorts counter them; capital ships decide sea control").
   * A zero means the formation may not be given that mission at all.
   *
   * Nothing here is a hard block on a *mission* — a bomber sent to fight for
   * the sky contributes at a fifth rather than not at all, so an air force
   * that is the wrong shape for the war it is in degrades instead of failing
   * (invariant 2). The zero is a shape rule, not a shortage rule.
   */
  weight: Readonly<Record<Mission, number>>;
}

const NO_NAVAL: Readonly<Record<NavalMission, number>> = {
  sea_control: 0,
  convoy_raiding: 0,
  convoy_escort: 0,
  invasion_support: 0,
} as const;

export const FORMATIONS: Readonly<Record<FormationTemplate, FormationSpec>> = {
  fighter_wing: {
    kind: "air",
    base: "air_base",
    equipment: { fighter: 24 },
    weight: {
      air_superiority: 1,
      ground_support: 0.35,
      interdiction: 0.3,
      strategic_bombing: 0.15,
      ...NO_NAVAL,
    },
  },
  bomber_wing: {
    kind: "air",
    base: "air_base",
    equipment: { bomber: 18 },
    weight: {
      air_superiority: 0.2,
      ground_support: 1,
      interdiction: 1,
      strategic_bombing: 1,
      ...NO_NAVAL,
    },
  },
} as const;

/** The templates of one zone kind, for the raise menu. */
export function templatesOfKind(kind: ZoneKind): FormationTemplate[] {
  return FORMATION_TEMPLATES.filter((id) => FORMATIONS[id].kind === kind);
}

/** Whether this mission belongs to the system this formation serves. */
export function missionSuitsKind(mission: Mission, kind: ZoneKind): boolean {
  return (MISSIONS_BY_KIND[kind] as readonly Mission[]).includes(mission);
}
