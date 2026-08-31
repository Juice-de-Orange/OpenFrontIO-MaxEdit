/**
 * The air war: what a tick over a zone costs, and who is left holding it.
 *
 * CLAUDE.md §6.7. The resolution itself lives in `zones.ts`, because §6.8 says
 * phase 9's fleets run on the same machine — this file is the thin half that
 * knows the contest is fought by aircraft, and it does exactly two things.
 *
 * **It charges for being in the sky.** Every formation in a contested zone
 * loses equipment, the losing side more than the winning one. Those losses are
 * `fighter` and `bomber` out of the national stockpile (§6.3), which is the
 * whole reason an air war is felt in the economy: a wing shot down is factory
 * hours that were not spent on rifles, and invariant 6 asks for exactly that.
 *
 * **It sends home what has nowhere to fly from.** A formation whose air base
 * is in a province the nation no longer controls stands down rather than going
 * on fighting out of somebody else's aerodrome.
 *
 * What it deliberately does *not* do is apply superiority to anything. The
 * three effects §6.7 lists all land on systems that already exist — ground
 * combat, supply and factory output — and each of those reads the ratio where
 * it needs it, through `zones.ts`, at the moment it is needed. A pure function
 * of the state is cheaper to trust than a number this system would have to
 * store, and it keeps the coupling one-directional.
 */

import {
  AIR_LOSS,
  AIR_LOSS_SWING,
  AIR_LOSS_UNCONTESTED,
} from "src/shared/config/air";
import { FORMATIONS } from "src/shared/economy/Formations";
import type { System } from ".";
import type { WorldEvent, WorldState } from "../world/WorldState";
import { contestOf, isContested, superiorityOf } from "./zones";

export const airSystem: System = {
  name: "air",

  run(state: WorldState): WorldEvent[] {
    const events: WorldEvent[] = [];

    // One contest per zone per tick rather than one per formation: several
    // wings of the same nation over the same zone would recompute the same
    // answer. Keyed by zone, and only for zones somebody is actually in.
    const contests = new Map<number, Map<number, number>>();
    const contestFor = (zone: number): Map<number, number> => {
      const known = contests.get(zone);
      if (known !== undefined) return known;
      const fresh = contestOf(state, zone, "air");
      contests.set(zone, fresh);
      return fresh;
    };

    for (let nation = 1; nation <= state.nationCount; nation++) {
      for (const formation of state.nations[nation].formations) {
        if (FORMATIONS[formation.template].kind !== "air") continue;

        // **The base was lost.** Standing the formation down is the honest
        // answer: it is not destroyed — the aircraft are equipment and the
        // equipment is still the nation's — but it has nowhere to fly from
        // until the province is retaken or another base is built.
        if (
          formation.zone !== null &&
          state.provinceController[formation.base] !== nation
        ) {
          events.push({
            kind: "formation_assigned",
            nation,
            formationId: formation.id,
            zone: null,
            mission: null,
          });
          continue;
        }

        if (formation.zone === null || formation.mission === null) continue;

        const contest = contestFor(formation.zone);
        // Patrolling empty sky is free. A player who won the air war outright
        // should not be paying for having won it, and attrition with no
        // opponent is supply's business (§6.6), not this system's.
        const share = isContested(contest, nation)
          ? AIR_LOSS + AIR_LOSS_SWING * (1 - superiorityOf(contest, nation)) * 2
          : AIR_LOSS_UNCONTESTED;
        if (share <= 0) continue;

        const delta: [number, number][] = [];
        for (let index = 0; index < formation.equipment.length; index++) {
          const held = formation.equipment[index];
          if (held <= 0) continue;
          delta.push([index, -Math.min(held, held * share)]);
        }
        if (delta.length === 0) continue;

        events.push({
          kind: "formation_equipment_changed",
          nation,
          formationId: formation.id,
          delta,
        });
      }
    }

    return events;
  },
};
