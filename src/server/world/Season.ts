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
 */

import { DEFAULT_REGENT } from "src/shared/config/regent";
import type { WorldStore } from "../db/Store";
import type { World } from "./World";
import type { WorldRunner } from "./WorldRunner";

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
      focus: DEFAULT_REGENT.focus,
      marketBudget: DEFAULT_REGENT.marketBudget,
    });
    opened++;
  }
  return opened;
}
