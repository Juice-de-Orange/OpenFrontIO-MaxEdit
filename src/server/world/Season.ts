/**
 * Opening a season: the one moment identity reaches into the simulation.
 *
 * Decision 0018 left the regent opt-in until the world could tell a played
 * nation from an abandoned one; decision 0019 gave it the means. This is the
 * promised other half: on a season world, every nation no account holds gets
 * its regent switched on at startup — through `submit`, like any player
 * command, so it is in the log and a replay reaches the same world without
 * ever asking the accounts table.
 *
 * Idempotent by inspection: a nation whose regent is already enabled is left
 * alone, so a restart submits nothing and the log does not grow by
 * fifty-two lines a boot.
 *
 * **Each regent gets a focus of its own**, drawn from the world seed. With
 * every unclaimed nation on "economy" the world had fifty-one identical
 * stewards and no war anybody had not started; a seed-drawn focus gives
 * the map personalities — a builder here, a fortress there, an expander
 * next door — that a player can read and plan against. Drawn here rather
 * than in the regent system so it goes through the log as a real command
 * and a replay reaches the same world without re-rolling anything.
 */

import { DEFAULT_REGENT, type RegentFocus } from "src/shared/config/regent";
import {
  focusForArchetype,
  nationIsCoastal,
  temperamentOf,
} from "src/shared/config/temperament";
import type { WorldStore } from "../db/Store";
import type { World } from "./World";
import type { WorldRunner } from "./WorldRunner";

/**
 * The focus a nation's regent opens the season with: the one its temperament
 * calls for (decision 0028). Pure: same seed and nation, same focus.
 */
export function regentFocusFor(
  worldSeed: number,
  nation: number,
  coastal: boolean,
): RegentFocus {
  return focusForArchetype(temperamentOf(worldSeed, nation, coastal).archetype);
}

/**
 * What the opening did: regents switched on, and — only with `reseedFocus` —
 * running regents whose focus was moved to the seed's.
 */
export interface SeasonOpening {
  opened: number;
  reseeded: number;
}

export async function openSeason(
  world: World,
  runner: WorldRunner,
  store: WorldStore,
  worldId: string,
  options: { reseedFocus?: boolean } = {},
): Promise<SeasonOpening> {
  const claimed = new Set(await store.claimedNations(worldId));
  const state = world.view();
  let opened = 0;
  let reseeded = 0;
  for (let nation = 1; nation <= world.nations.length; nation++) {
    // A claimed nation's regent is its player's to configure (invariant 7);
    // the world never touches it, opening or reseeding.
    if (claimed.has(nation)) continue;
    const regent = state.nations[nation].regent;
    const focus = regentFocusFor(
      state.worldSeed,
      nation,
      nationIsCoastal(state.map, nation),
    );
    if (regent.enabled) {
      // **The operator's one-off** (`REGENT_FOCUS_RESEED=1`): a season opened
      // before regents drew a focus has every steward on the default. Moving
      // them onto the seed's draw is the same command the opening submits,
      // through the same log, and only where the focus actually differs — so
      // the flag can stay set across restarts without writing a line.
      if (!options.reseedFocus || regent.focus === focus) continue;
      await runner.submit(nation, {
        kind: "configure_regent",
        enabled: true,
        focus,
        marketBudget: regent.marketBudget,
      });
      reseeded++;
      continue;
    }
    await runner.submit(nation, {
      kind: "configure_regent",
      enabled: true,
      focus,
      marketBudget: DEFAULT_REGENT.marketBudget,
    });
    opened++;
  }
  return { opened, reseeded };
}
