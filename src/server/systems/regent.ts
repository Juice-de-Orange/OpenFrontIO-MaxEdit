/**
 * The regent: the world playing a nation nobody is playing.
 *
 * CLAUDE.md §6.10, and load-bearing rather than a convenience: with a
 * five-second tick the regent plays the majority of a nation's ticks, and if
 * it cannot hold a front, players do not come back. Rule-based, no search,
 * no planning, no learning; it runs every `REGENT_INTERVAL_TICKS`, not every
 * tick, and it emits the same events a player's commands would — which is
 * what keeps a replayed world identical to the run: the rules are pure
 * functions of the state, so the replay reaches the same conclusions.
 *
 * **The one rule that matters most**: it never changes an existing
 * production line's equipment type. That would reset the efficiency ramp to
 * the floor (§6.2) and destroy in one decision what a player spent days
 * building. Idle factories only.
 *
 * Per invariant 7 it never proposes, accepts or cancels an agreement, never
 * abandons a capital, and never orders a naval invasion. Its one economic
 * reaction is the world market, up to `marketBudget` — and the offensive
 * order the `expansion` focus places is §6.10's own text, not an exception:
 * "offensive orders against the weakest adjacent border with which no
 * agreement exists".
 *
 * Two of §6.10's baseline duties are translated for a world whose divisions
 * cannot move (decision 0018): "retreat units that are collapsing" becomes
 * calling off an attack whose staging has crumbled — the only retreat this
 * game has — and "keep units supplied" becomes building a supply hub where a
 * division is starving, which is what a player would do (the phase-8 gate's
 * bottomless-pit lesson).
 */

import { DIVISION_MANPOWER } from "src/shared/config/rates";
import {
  REGENT_HUB_BELOW,
  REGENT_INTERVAL_TICKS,
  REGENT_RETREAT_STRENGTH,
  type RegentFocus,
} from "src/shared/config/regent";
import { TECH_IDS, isAvailable, slotsFor } from "src/shared/config/techs";
import { BUILDINGS, type BuildingType } from "src/shared/economy/Buildings";
import { EQUIPMENT } from "src/shared/economy/Equipment";
import type { System } from ".";
import {
  assignedFactories,
  atPeace,
  availableFactories,
  countBuilding,
  divisionStrength,
  usedSlots,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";
import { measureNation } from "./economy";
import { supplyCoverage, supplyOf, supplyReach } from "./supply";

/** What each focus builds when the queue is empty, in order of preference. */
const FOCUS_BUILDINGS: Readonly<Record<RegentFocus, readonly BuildingType[]>> =
  {
    economy: ["civilian_factory", "infrastructure"],
    military: ["military_factory", "civilian_factory"],
    defence: ["supply_hub", "military_factory"],
    expansion: ["military_factory", "infrastructure"],
  };



/** Whether this building can go in this province right now. */
function buildable(
  state: WorldState,
  nation: number,
  province: number,
  building: BuildingType,
): boolean {
  const spec = BUILDINGS[building];
  const info = state.map.provinces[province];
  if (info === undefined) return false;
  if (state.provinceController[province] !== nation) return false;
  if (state.provinceOwner[province] !== nation) return false;
  if (spec.coastalOnly && !info.coastal) return false;
  if (spec.takesSlot && usedSlots(state, province) >= info.buildingSlots) {
    return false;
  }
  if (
    spec.maxPerProvince !== undefined &&
    countBuilding(state, province, building) >= spec.maxPerProvince
  ) {
    return false;
  }
  return true;
}

/** The provinces a nation controls, ascending — the deterministic order. */
function controlled(state: WorldState, nation: number): number[] {
  const mine: number[] = [];
  for (
    let province = 0;
    province < state.provinceController.length;
    province++
  ) {
    if (state.provinceController[province] === nation) mine.push(province);
  }
  return mine;
}

export const regentSystem: System = {
  name: "regent",

  run(state: WorldState, tick: number): WorldEvent[] {
    // Half an in-game day between thoughts (§6.10). A steward that reacts
    // faster than the world moves is micromanaging.
    if (tick % REGENT_INTERVAL_TICKS !== 0) return [];

    const events: WorldEvent[] = [];
    for (let nation = 1; nation <= state.nationCount; nation++) {
      const it = state.nations[nation];
      if (!it.regent.enabled) continue;
      const focus = it.regent.focus;
      const mine = controlled(state, nation);
      if (mine.length === 0) continue;

      const reach = supplyReach(state, nation);
      const coverage = supplyCoverage(state, nation);

      // **A garrison at home.** §6.10's baseline keeps the nation defensible,
      // and a capital with nobody in it falls to the first order given
      // against it — the march rate is all that would slow the taking. One
      // division, in the capital, before anything else spends the manpower.
      const capital = mine.find(
        (province) =>
          state.map.provinces[province].capital &&
          state.provinceOwner[province] === nation,
      );
      if (
        capital !== undefined &&
        it.manpower >= DIVISION_MANPOWER &&
        !it.divisions.some((division) => division.province === capital)
      ) {
        events.push(
          { kind: "division_raised", nation, province: capital },
          { kind: "manpower_changed", nation, delta: -DIVISION_MANPOWER },
        );
      }

      // **The retreat.** An attack whose staging has crumbled — no division
      // next to the target still worth its keep — is called off rather than
      // left grinding the last equipment out of a lost fight. Divisions do
      // not move in this game, so this is the only retreat there is.
      for (const attack of it.attacks) {
        const staging = state.map.provinces[attack.province].neighbours.filter(
          (province) => state.provinceController[province] === nation,
        );
        const standing = staging.some((province) =>
          it.divisions.some(
            (division) =>
              division.province === province &&
              divisionStrength(division) >= REGENT_RETREAT_STRENGTH,
          ),
        );
        if (!standing) {
          events.push({
            kind: "attack_ended",
            nation,
            province: attack.province,
          });
        }
      }

      // **The queue stays non-empty.** A starving division's hub comes first
      // — the bottomless-pit lesson — then whatever the focus wants, in the
      // first province that can take it.
      if (it.constructionQueue.length === 0) {
        let queued = false;
        for (const division of it.divisions) {
          if (division.province < 0) continue;
          if (
            supplyOf(reach, coverage, division.province) >= REGENT_HUB_BELOW
          ) {
            continue;
          }
          if (
            countBuilding(state, division.province, "supply_hub") > 0 ||
            !buildable(state, nation, division.province, "supply_hub")
          ) {
            continue;
          }
          events.push({
            kind: "construction_queued",
            nation,
            order: {
              provinceId: division.province,
              building: "supply_hub",
              progress: 0,
            },
          });
          queued = true;
          break;
        }
        if (!queued) {
          outer: for (const building of FOCUS_BUILDINGS[focus]) {
            for (const province of mine) {
              if (!buildable(state, nation, province, building)) continue;
              events.push({
                kind: "construction_queued",
                nation,
                order: { provinceId: province, building, progress: 0 },
              });
              break outer;
            }
          }
        }
      }

      // **Idle military factories go to a line — never a line to another
      // equipment type.** A division's strength is the *worst* ratio across
      // its template (§6.3), so a nation making only rifles arms nobody —
      // the phase-6 gate's lesson, and a steward has to know it. Both
      // template lines are opened as the factories allow, rifles first, and
      // the idle factories are split with artillery taking the smaller half
      // (a division wants 100 rifles to 12 guns, but a gun is four times
      // the work). New lines are staffed on the next visit — a steward is
      // allowed to be slow.
      const total = availableFactories(state, nation, "military_factory");
      const idle = total - assignedFactories(state, nation, "military_factory");
      const military = it.productionLines.filter(
        (line) => EQUIPMENT[line.equipment].yard === "military_factory",
      );
      const rifles = military.find(
        (line) => line.equipment === "infantry_equipment",
      );
      const guns = military.find((line) => line.equipment === "artillery");
      if (rifles === undefined) {
        events.push({
          kind: "production_line_created",
          nation,
          equipment: "infantry_equipment",
        });
      } else if (guns === undefined && total >= 2) {
        events.push({
          kind: "production_line_created",
          nation,
          equipment: "artillery",
        });
      } else if (idle > 0) {
        const gunsWanted =
          guns === undefined ? 0 : Math.max(1, Math.floor(total / 3));
        if (guns !== undefined && guns.factories !== gunsWanted) {
          events.push({
            kind: "production_factories_assigned",
            nation,
            lineId: guns.id,
            factories: gunsWanted,
          });
        }
        const riflesWanted =
          total - gunsWanted -
          military
            .filter((line) => line !== rifles && line !== guns)
            .reduce((sum, line) => sum + line.factories, 0);
        if (rifles.factories !== riflesWanted && riflesWanted >= 0) {
          events.push({
            kind: "production_factories_assigned",
            nation,
            lineId: rifles.id,
            factories: riflesWanted,
          });
        }
      }

      // **Research slots stay filled**, with the first tech the flat list
      // offers — deterministically, so a replay picks the same one.
      const unlocked = slotsFor(it.unlockedTechs);
      const running = new Set(
        it.researchSlots
          .map((slot) => slot.tech)
          .filter((tech) => tech !== null),
      );
      for (let slot = 0; slot < unlocked; slot++) {
        if (it.researchSlots[slot].tech !== null) continue;
        const tech = TECH_IDS.find(
          (id) =>
            !it.unlockedTechs.includes(id) &&
            !running.has(id) &&
            isAvailable(id, it.unlockedTechs),
        );
        if (tech === undefined) break;
        events.push({ kind: "research_started", nation, slot, tech });
        running.add(tech);
      }

      // **The market, up to the budget** — the regent's only economic
      // reaction (§6.10, invariant 7: an order at the market is not an
      // obligation). A shortage buys the scarcest resource; a healthy
      // economy clears the order rather than paying the market's rates for
      // ever.
      const economy = measureNation(state, nation);
      if (economy.sufficiency < 1) {
        let scarcest: "steel" | "oil" | "aluminium" | "rubber" | null = null;
        let worst = Infinity;
        for (const resource of [
          "steel",
          "oil",
          "aluminium",
          "rubber",
        ] as const) {
          const demand = economy.demand[resource];
          if (demand <= 0) continue;
          const cover =
            (it.resources[resource] + economy.extraction[resource]) / demand;
          if (cover < worst) {
            worst = cover;
            scarcest = resource;
          }
        }
        if (scarcest !== null && it.regent.marketBudget > 0) {
          const wanted = Math.min(
            it.regent.marketBudget,
            economy.demand[scarcest],
          );
          if (it.market[scarcest] !== wanted) {
            events.push({
              kind: "market_order_set",
              nation,
              resource: scarcest,
              perTick: wanted,
            });
          }
        }
      } else {
        for (const resource of [
          "steel",
          "oil",
          "aluminium",
          "rubber",
        ] as const) {
          if (it.market[resource] > 0) {
            events.push({
              kind: "market_order_set",
              nation,
              resource,
              perTick: 0,
            });
          }
        }
      }

      // **Expansion, and only expansion, attacks** — §6.10's own sentence:
      // the weakest adjacent border with which no agreement exists. One
      // front at a time; a steward does not open a second war.
      if (focus === "expansion" && it.attacks.length === 0) {
        let target = -1;
        let weakest = Infinity;
        for (const province of mine) {
          for (const next of state.map.provinces[province].neighbours) {
            const holder = state.provinceController[next];
            if (holder === nation || holder <= 0) continue;
            if (atPeace(state, nation, holder)) continue;
            const garrison = state.nations[holder].divisions
              .filter((division) => division.province === next)
              .reduce((sum, division) => sum + divisionStrength(division), 0);
            if (garrison < weakest || (garrison === weakest && next < target)) {
              weakest = garrison;
              target = next;
            }
          }
        }
        if (target >= 0) {
          events.push({ kind: "attack_ordered", nation, province: target });
        }
      }
    }

    return events;
  },
};
