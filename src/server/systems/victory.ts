/**
 * The victory system: when a season is won, and when it merely ends.
 *
 * §10, decided: an alliance bloc holding `VICTORY_SHARE` of all provinces
 * for `VICTORY_HOLD_TICKS` wins outright; an unwon season ends at
 * `SEASON_TICKS` and the highest score wins — provinces, industry, trust.
 * Blocs, not nations: the season victory condition evaluates alliance blocs
 * (§6.5), because evaluating individuals makes alliances strictly
 * self-defeating and nobody would form one.
 *
 * A bloc is a connected component over live alliances (decision 0020):
 * allied-with-my-ally is in my bloc. A solo nation is a bloc of one, so an
 * empire that trusts nobody can still win — it just gets no help.
 *
 * Winning does not stop the world. The system emits `season_won` once, the
 * state remembers it for ever, the wire tells everyone — and archiving the
 * season and opening a fresh world is an operator's act (phase 12), not a
 * tick's.
 */

import {
  SCORE_INDUSTRY,
  SCORE_PROVINCE,
  SCORE_TRUST,
  SEASON_TICKS,
  VICTORY_HOLD_TICKS,
  VICTORY_SHARE,
} from "src/shared/config/victory";
import type { System } from ".";
import {
  agreementIsLive,
  type WorldEvent,
  type WorldState,
} from "../world/WorldState";
import { measureNation } from "./economy";

/**
 * Every nation's bloc, as connected components over live alliances.
 *
 * Union-find would be the textbook answer; with fifty-two nations and a
 * handful of alliances, a repeated sweep is simpler to read and costs
 * nothing measurable.
 */
export function blocsOf(state: WorldState): number[][] {
  const bloc = new Array<number>(state.nationCount + 1);
  for (let nation = 1; nation <= state.nationCount; nation++) {
    bloc[nation] = nation;
  }
  const rootOf = (nation: number): number => {
    let at = nation;
    while (bloc[at] !== at) at = bloc[at];
    return at;
  };
  for (const agreement of state.agreements) {
    if (agreement.type !== "alliance") continue;
    if (!agreementIsLive(agreement, state.tick)) continue;
    const a = rootOf(agreement.parties[0]);
    const b = rootOf(agreement.parties[1]);
    if (a !== b) bloc[Math.max(a, b)] = Math.min(a, b);
  }
  const members = new Map<number, number[]>();
  for (let nation = 1; nation <= state.nationCount; nation++) {
    const root = rootOf(nation);
    const list = members.get(root) ?? [];
    list.push(nation);
    members.set(root, list);
  }
  return [...members.values()];
}

function sameMembers(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A bloc's end-of-season score: §10's own order, weighted to all matter. */
function scoreOf(state: WorldState, members: number[]): number {
  let provinces = 0;
  for (const holder of state.provinceController) {
    if (members.includes(holder)) provinces++;
  }
  let industry = 0;
  let trust = 0;
  for (const nation of members) {
    industry += measureNation(state, nation).industry;
    trust += state.nations[nation].trust;
  }
  return (
    provinces * SCORE_PROVINCE + industry * SCORE_INDUSTRY + trust * SCORE_TRUST
  );
}

export const victorySystem: System = {
  name: "victory",

  run(state: WorldState, tick: number): WorldEvent[] {
    // A decided season stays decided; the world turns on underneath it.
    if (state.winner !== null) return [];

    const events: WorldEvent[] = [];
    const blocs = blocsOf(state);

    // --- Domination: the held-for counter. -------------------------------
    const held = new Array<number>(state.nationCount + 1).fill(0);
    let total = 0;
    for (const holder of state.provinceController) {
      total++;
      if (holder > 0) held[holder]++;
    }
    let leader: number[] | null = null;
    for (const members of blocs) {
      let sum = 0;
      for (const nation of members) sum += held[nation];
      if (sum / total >= VICTORY_SHARE) {
        // Two blocs cannot both hold 40%+ unless the share is under 50%,
        // which it is — so the larger holding leads, ties to the first
        // (lowest-rooted) bloc for determinism.
        if (
          leader === null ||
          sum > leader.reduce((acc, nation) => acc + held[nation], 0)
        ) {
          leader = members;
        }
      }
    }

    if (leader === null) {
      if (state.victoryHold !== null) {
        events.push({
          kind: "victory_hold_changed",
          members: null,
          since: tick,
        });
      }
    } else if (
      state.victoryHold === null ||
      !sameMembers(state.victoryHold.members, leader)
    ) {
      // A new bloc on the threshold starts its own clock — including a bloc
      // that changed shape mid-hold: an alliance signed or broken makes a
      // different bloc, and a different bloc has held nothing yet.
      events.push({
        kind: "victory_hold_changed",
        members: leader,
        since: tick,
      });
    } else if (tick - state.victoryHold.since >= VICTORY_HOLD_TICKS) {
      events.push({
        kind: "season_won",
        members: leader,
        reason: "domination",
        at: tick,
      });
      return events;
    }

    // --- The clock: an unwon season ends, and the score decides. ---------
    if (tick >= SEASON_TICKS) {
      let best: number[] | null = null;
      let bestScore = -Infinity;
      for (const members of blocs) {
        const score = scoreOf(state, members);
        if (
          score > bestScore ||
          (score === bestScore && best !== null && members[0] < best[0])
        ) {
          best = members;
          bestScore = score;
        }
      }
      if (best !== null) {
        events.push({
          kind: "season_won",
          members: best,
          reason: "score",
          at: tick,
        });
      }
    }

    return events;
  },
};
