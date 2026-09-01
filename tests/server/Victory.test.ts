import { beforeEach, describe, expect, test } from "vitest";
import { blocsOf, victorySystem } from "../../src/server/systems/victory";
import { World } from "../../src/server/world/World";
import { applyEvent, type WorldState } from "../../src/server/world/WorldState";
import {
  SEASON_TICKS,
  VICTORY_HOLD_TICKS,
  VICTORY_SHARE,
} from "../../src/shared/config/victory";
import { mapFixture } from "../util/worldFixture";

/**
 * §10's victory condition, driven directly.
 *
 * Blocs over live alliances, a held-for counter that resets when the bloc
 * changes shape or slips under the share, one winner for ever, and a season
 * that ends on points when nobody dominated. The system is pure state
 * arithmetic, so unlike the phased systems it needs no gate over a socket —
 * these tests are its demonstration.
 */
function build(): { world: World; state: WorldState } {
  const fixture = mapFixture({
    width: 320,
    height: 140,
    capitals: [
      { x: 40, y: 40 },
      { x: 280, y: 40 },
      { x: 40, y: 100 },
      { x: 280, y: 100 },
      { x: 160, y: 70 },
    ],
  });
  const world = World.create(
    fixture.descriptor,
    fixture.nations,
    fixture.map,
    11,
  );
  return { world, state: world.view() as WorldState };
}

function ally(state: WorldState, a: number, b: number): void {
  state.agreements.push({
    id: state.nextAgreementId++,
    type: "alliance",
    parties: [a, b],
    terms: null,
    accepted: true,
    noticeAt: null,
    noticeBy: null,
  });
}

/** Hand every province of `from` to `to` — the map, redrawn for a test. */
function conquer(state: WorldState, from: number, to: number): void {
  for (let i = 0; i < state.provinceController.length; i++) {
    if (state.provinceController[i] === from) state.provinceController[i] = to;
  }
}

function shareOf(state: WorldState, members: number[]): number {
  let held = 0;
  for (const holder of state.provinceController) {
    if (members.includes(holder)) held++;
  }
  return held / state.provinceController.length;
}

function run(state: WorldState, tick: number): void {
  for (const event of victorySystem.run(state, tick)) {
    applyEvent(state, event);
  }
}

describe("the victory system", () => {
  let state: WorldState;

  beforeEach(() => {
    ({ state } = build());
  });

  test("blocs are transitive over live alliances, and solo nations are blocs of one", () => {
    ally(state, 1, 2);
    ally(state, 2, 3);
    const blocs = blocsOf(state).map((bloc) => bloc.join(","));
    expect(blocs).toContain("1,2,3");
    expect(blocs).toContain("4");
    expect(blocs).toContain("5");

    // An alliance under notice still binds until it lapses; a lapsed one
    // does not. Push the first alliance past its notice period.
    state.agreements[0].noticeAt = 0;
    state.tick = 100_000;
    const later = blocsOf(state).map((bloc) => bloc.join(","));
    expect(later).toContain("2,3");
    expect(later).toContain("1");
  });

  test("the held-for counter starts, survives, and completes into a win", () => {
    ally(state, 1, 2);
    conquer(state, 3, 1); // bloc {1,2} takes nation 3's ground
    expect(shareOf(state, [1, 2])).toBeGreaterThanOrEqual(VICTORY_SHARE);

    run(state, 1000);
    expect(state.victoryHold).toEqual({ members: [1, 2], since: 1000 });
    expect(state.winner).toBeNull();

    // Held, tick after tick, until §10's seven days are up.
    run(state, 1000 + VICTORY_HOLD_TICKS - 1);
    expect(state.winner).toBeNull();
    run(state, 1000 + VICTORY_HOLD_TICKS);
    expect(state.winner).toEqual({
      members: [1, 2],
      reason: "domination",
      at: 1000 + VICTORY_HOLD_TICKS,
    });

    // Decided means decided: the system emits nothing more, whatever the
    // map does next.
    conquer(state, 1, 4);
    expect(victorySystem.run(state, 1000 + VICTORY_HOLD_TICKS + 1)).toEqual([]);
  });

  test("losing the share resets the clock; a reshaped bloc starts its own", () => {
    ally(state, 1, 2);
    conquer(state, 3, 1);
    run(state, 500);
    expect(state.victoryHold?.since).toBe(500);

    // Ground bleeds back to nation 3 — which holds nothing, so no other
    // bloc inherits the threshold — until the holders dip under the share.
    // The first sloppy version of this handed everything to nation 4, which
    // then stood on 40% itself, and the system rightly gave *it* the clock.
    const lost: number[] = [];
    for (
      let province = 0;
      province < state.provinceController.length &&
      shareOf(state, [1, 2]) >= VICTORY_SHARE;
      province++
    ) {
      if (state.provinceController[province] === 1) {
        state.provinceController[province] = 3;
        lost.push(province);
      }
    }
    run(state, 600);
    expect(state.victoryHold).toBeNull();

    // Retaken — but by a *different* bloc (a third ally joined): the clock
    // starts over rather than resuming, because a different bloc has held
    // nothing yet.
    for (const province of lost) state.provinceController[province] = 1;
    ally(state, 2, 5);
    run(state, 700);
    expect(state.victoryHold?.members).toEqual([1, 2, 5]);
    expect(state.victoryHold?.since).toBe(700);
  });

  test("an unwon season ends on points, blocs scored together", () => {
    ally(state, 1, 2);
    // Nobody near the share; the clock simply runs out.
    run(state, SEASON_TICKS);
    expect(state.winner).not.toBeNull();
    expect(state.winner?.reason).toBe("score");
    // The allied pair holds the most provinces together on this fixture, so
    // the bloc — not either member alone — takes the season.
    expect(state.winner?.members).toEqual([1, 2]);
  });
});
