/**
 * The sea war: what a tick in a contested zone costs, and what the raiders
 * sink.
 *
 * CLAUDE.md §6.8, by way of decision 0015: the resolution itself lives in
 * `zones.ts`, the same machine the air war runs on — this file is the thin
 * half that knows the contest is fought by ships, and it does three things.
 *
 * **It charges for being in a contested sea.** Every fleet in one loses
 * equipment, the losing side more than the winning one, exactly as the air
 * system does. Those losses are submarines, escorts and capital ships out of
 * the national stockpile (§6.3), which is what makes a naval war felt in the
 * economy: dockyard time, spent (invariant 6).
 *
 * **It sends home what has nowhere to sail from.** A fleet whose naval base
 * is in a province the nation no longer controls stands down.
 *
 * **It sinks convoys.** Raiders over the zones a nation's sea routes cross —
 * supply routes and seaborne trade alike — destroy `convoy` equipment, less
 * whatever the escorts in the same zones cover. This runs *after* supply on
 * purpose (see `systems/index.ts`): supply computes the demand, naval sinks
 * the ships carrying it, and the shortfall lands on the following tick. That
 * one-tick lag is the design, not a bug to fix.
 *
 * What it deliberately does *not* do is apply superiority to anything —
 * §6.8's effects are read where they are needed, through `zones.ts`, the
 * same way the air war's are: sea supply and seaborne trade read the raid
 * where convoys are consumed, and the invasion reads `sea_control` where it
 * is ordered.
 */

import {
  CONVOY_RAID_LOSS,
  CONVOYS_PER_TRADE_FLOW_ZONE,
  INVASION_LANDING_FACTOR,
  NAVAL_LOSS,
  NAVAL_LOSS_SWING,
  NAVAL_LOSS_UNCONTESTED,
} from "src/shared/config/naval";
import { equipmentIndex } from "src/shared/economy/Equipment";
import { FORMATIONS } from "src/shared/economy/Formations";
import { tradeFlowRate } from "src/shared/economy/Trade";
import type { System } from ".";
import { atPeace, type WorldEvent, type WorldState } from "../world/WorldState";
import { netRaidOver, seaSupplyRoutes } from "./supply";
import { tradeContext } from "./trade";
import { contestOf, isContested, superiorityOf } from "./zones";

export const navalSystem: System = {
  name: "naval",

  run(state: WorldState): WorldEvent[] {
    const events: WorldEvent[] = [];

    // One contest per zone per tick, exactly as the air system keeps one.
    const contests = new Map<number, Map<number, number>>();
    const contestFor = (zone: number): Map<number, number> => {
      const known = contests.get(zone);
      if (known !== undefined) return known;
      const fresh = contestOf(state, zone, "naval");
      contests.set(zone, fresh);
      return fresh;
    };

    for (let nation = 1; nation <= state.nationCount; nation++) {
      for (const formation of state.nations[nation].formations) {
        if (FORMATIONS[formation.template].kind !== "naval") continue;

        // **The base was lost.** Standing down, not sinking: the ships are
        // equipment and the equipment is still the nation's, but a fleet
        // does not go on fighting out of somebody else's harbour.
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
        // An empty sea is free to sail; attrition with no opponent is
        // supply's business, not this system's.
        const share = isContested(contest, nation)
          ? NAVAL_LOSS +
            NAVAL_LOSS_SWING * (1 - superiorityOf(contest, nation)) * 2
          : NAVAL_LOSS_UNCONTESTED;
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

    // **The crossings.** Each transit spends a tick; the one on its last
    // tick lands — onto an empty beach, taking the province, or into a
    // garrison or a fresh peace, and turns back. The march analogy holds
    // (invariant 1): the operation is the rate, and everyone watching had
    // the whole crossing to answer it.
    for (let nation = 1; nation <= state.nationCount; nation++) {
      for (const transit of state.nations[nation].seaTransits) {
        if (transit.ticksLeft > 1) {
          events.push({ kind: "invasion_progressed", nation, id: transit.id });
          continue;
        }
        const holder = state.provinceController[transit.to];
        const defended =
          holder > 0 &&
          holder !== nation &&
          state.nations[holder].divisions.some(
            (division) => division.province === transit.to,
          );
        const peace = holder > 0 && atPeace(state, nation, holder);
        const landed = !defended && !peace;
        if (landed) {
          const division = state.nations[nation].divisions.find(
            (it) => it.id === transit.divisionId,
          );
          if (division !== undefined) {
            // §6.8: it lands at reduced strength. The surf takes its share
            // of everything the division carries.
            const delta: [number, number][] = [];
            for (let index = 0; index < division.equipment.length; index++) {
              const held = division.equipment[index];
              if (held <= 0) continue;
              delta.push([index, -held * (1 - INVASION_LANDING_FACTOR)]);
            }
            if (delta.length > 0) {
              events.push({
                kind: "division_equipment_changed",
                nation,
                divisionId: division.id,
                delta,
              });
            }
          }
          if (holder !== nation) {
            events.push({
              kind: "control_changed",
              province: transit.to,
              nation,
            });
          }
        }
        events.push({
          kind: "invasion_landed",
          nation,
          id: transit.id,
          landed,
        });
      }
    }

    // **The raiders' harvest.** For every nation with ships at sea in the
    // merchant sense — sea supply routes, seaborne trade — the worst net
    // raid over any zone its routes cross sinks a share of the convoys it
    // actually has in use. In use, not in the warehouse: a nation with a
    // thousand convoys and no sea traffic loses none of them, because there
    // is nothing on the water to sink (invariant 6 read backwards — no
    // economic footprint without an economic activity to stamp on).
    const convoy = equipmentIndex("ships");
    const context = tradeContext(state);
    for (let nation = 1; nation <= state.nationCount; nation++) {
      const held = state.nations[nation].stockpile[convoy] ?? 0;
      if (held <= 0) continue;

      let wanted = 0;
      let raid = 0;
      for (const route of seaSupplyRoutes(state, nation)) {
        wanted += route.convoysWanted;
        for (const zone of route.path) {
          raid = Math.max(raid, netRaidOver(state, nation, zone));
        }
      }
      for (const agreement of context.live) {
        if (agreement.parties[1] !== nation) continue;
        if (agreement.terms === null) continue;
        const route = context.routes.get(agreement.id);
        if (route === undefined || route.kind !== "sea") continue;
        // The same pricing the trade system uses, `max(1, zones)` included:
        // a route inside a single zone crosses nothing but its ships are on
        // that water all the same, and the first gate run proved it — the
        // raiders sank exactly zero because this line priced the exposure
        // at `zones × rate` and zones was 0.
        wanted +=
          CONVOYS_PER_TRADE_FLOW_ZONE *
          tradeFlowRate(agreement.terms) *
          Math.max(1, route.zones);
        for (const zone of route.path) {
          raid = Math.max(raid, netRaidOver(state, nation, zone));
        }
      }
      if (wanted <= 0 || raid <= 0) continue;

      const exposed = Math.min(held, wanted);
      const sunk = Math.min(held, CONVOY_RAID_LOSS * raid * exposed);
      if (sunk <= 0) continue;
      events.push({
        kind: "stockpile_changed",
        nation,
        delta: [[convoy, -sunk]],
      });
    }

    return events;
  },
};
