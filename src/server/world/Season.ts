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

import {
  DEFAULT_REGENT,
  REGENT_FOCI,
  type RegentFocus,
} from "src/shared/config/regent";
import { PseudoRandom } from "src/shared/util/PseudoRandom";
import type { WorldStore } from "../db/Store";
import type { World } from "./World";
import type { WorldRunner } from "./WorldRunner";

/**
 * The focus a nation's regent opens the season with. Pure: same seed and
 * nation, same focus. A different salt from `rulerName`, so a ruler's name
 * says nothing about how they play.
 */
export function regentFocusFor(worldSeed: number, nation: number): RegentFocus {
  const random = new PseudoRandom(
    (worldSeed ^ Math.imul(nation, 0x85ebca6b) ^ 0x5eed0) >>> 0,
  );
  return REGENT_FOCI[Math.floor(random.next() * REGENT_FOCI.length)];
}

export async function openSeason(
  world: World,
  runner: WorldRunner,
  store: WorldStore,
  worldId: string,
): Promise<number> {
  const claimed = new Set(await store.claimedNations(worldId));
  const state = world.view();
  let opened = 0;
  for (let nation = 1; nation <= world.nations.length; nation++) {
    if (claimed.has(nation)) continue;
    if (state.nations[nation].regent.enabled) continue;
    await runner.submit(nation, {
      kind: "configure_regent",
      enabled: true,
      focus: regentFocusFor(state.worldSeed, nation),
      marketBudget: DEFAULT_REGENT.marketBudget,
    });
    opened++;
  }
  return opened;
}
