import { beforeEach, describe, expect, test } from "vitest";
import { measureNation } from "../../src/server/systems/economy";
import { World } from "../../src/server/world/World";
import { efficiencyCapFor } from "../../src/server/world/WorldState";
import { EFFICIENCY_CAP } from "../../src/shared/config/rates";
import {
  MAX_RESEARCH_SLOTS,
  modifiersOf,
  RESEARCH_SLOTS,
  slotsFor,
  TECHS,
} from "../../src/shared/config/techs";
import { mapFixture } from "../util/worldFixture";

function build(): { world: World; nation: number } {
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
  const capital = fixture.map.provinces.find((p) => p.capital);
  expect(capital).toBeDefined();
  return {
    world: World.create(fixture.descriptor, fixture.nations, fixture.map),
    nation: (capital as { nation: number }).nation,
  };
}

describe("the tech list itself", () => {
  test("every prerequisite names a tech that exists", () => {
    for (const [id, tech] of Object.entries(TECHS)) {
      for (const need of tech.requires) {
        expect(
          TECHS[need],
          `${id} requires the unknown tech ${need}`,
        ).toBeDefined();
      }
    }
  });

  test("no tech requires itself, directly or through a chain", () => {
    const reached = (id: keyof typeof TECHS, seen: string[]): void => {
      expect(seen, `${id} is in a prerequisite cycle`).not.toContain(id);
      for (const need of TECHS[id].requires) reached(need, [...seen, id]);
    };
    for (const id of Object.keys(TECHS) as (keyof typeof TECHS)[]) {
      reached(id, []);
    }
  });

  test("slots start at the default and stop at the cap", () => {
    expect(slotsFor([])).toBe(RESEARCH_SLOTS);
    expect(slotsFor(["research_bureau"])).toBe(RESEARCH_SLOTS + 1);
    // §6.4 caps it whatever the list says, so the state's fixed-length slot
    // array can never be outgrown.
    expect(slotsFor(Object.keys(TECHS) as never)).toBeLessThanOrEqual(
      MAX_RESEARCH_SLOTS,
    );
  });

  test("modifiers add rather than compound", () => {
    const both = modifiersOf(["machine_tools", "precision_tooling"]);
    expect(both.factoryOutput).toBeCloseTo(
      (TECHS.machine_tools.effect.factoryOutput ?? 0) +
        (TECHS.precision_tooling.effect.factoryOutput ?? 0),
      9,
    );
  });
});

describe("researching", () => {
  let world: World;
  let nation: number;

  beforeEach(() => {
    ({ world, nation } = build());
  });

  function command(body: Parameters<World["rejectionFor"]>[0]["body"]): void {
    const full = { nation, body };
    expect(world.rejectionFor(full)).toBeNull();
    world.queueCommand(full);
    world.step();
  }

  function slots() {
    return world.view().nations[nation].researchSlots;
  }

  test("a slot accrues one tick at a time, never in a jump", () => {
    command({ kind: "start_research", slot: 0, tech: "reinforced_concrete" });
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      world.step();
      seen.push(slots()[0].progress);
    }
    // Invariant 1: a player watching this number sees it move, every tick.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] - seen[i - 1]).toBe(1);
    }
  });

  test("a tech nobody has the prerequisites for is refused, not queued", () => {
    expect(
      world.rejectionFor({
        nation,
        body: { kind: "start_research", slot: 0, tech: "deep_mining" },
      }),
    ).toContain("excavation");
  });

  test("a slot the nation has not unlocked is refused", () => {
    expect(
      world.rejectionFor({
        nation,
        body: {
          kind: "start_research",
          slot: RESEARCH_SLOTS,
          tech: "excavation",
        },
      }),
    ).toContain("research slots");
  });

  test("two slots cannot work on the same tech", () => {
    command({ kind: "start_research", slot: 0, tech: "excavation" });
    expect(
      world.rejectionFor({
        nation,
        body: { kind: "start_research", slot: 1, tech: "excavation" },
      }),
    ).toContain("already researching");
  });

  test("cancelling loses the hours, like a cancelled building", () => {
    command({ kind: "start_research", slot: 0, tech: "excavation" });
    for (let i = 0; i < 30; i++) world.step();
    expect(slots()[0].progress).toBeGreaterThan(0);
    command({ kind: "cancel_research", slot: 0 });
    expect(slots()[0].tech).toBeNull();
    expect(slots()[0].progress).toBe(0);
  });
});

describe("a finished tech changes a number", () => {
  let world: World;
  let nation: number;

  beforeEach(() => {
    ({ world, nation } = build());
  });

  function research(tech: keyof typeof TECHS): void {
    const full = {
      nation,
      body: { kind: "start_research" as const, slot: 0, tech },
    };
    expect(world.rejectionFor(full)).toBeNull();
    world.queueCommand(full);
    // One step to apply the command, then the tech's own hours.
    for (let i = 0; i <= TECHS[tech].ticks; i++) world.step();
    expect(world.view().nations[nation].unlockedTechs).toContain(tech);
  }

  test("extraction research raises what the mines yield", () => {
    const before = measureNation(world.view(), nation).extraction;
    research("excavation");
    const after = measureNation(world.view(), nation).extraction;
    const moved = (["steel", "oil", "aluminium", "rubber"] as const).some(
      (r) => after[r] > before[r],
    );
    expect(moved, "no resource yields more than it did").toBe(true);
  });

  test("assembly-line research raises the ceiling a line may climb to", () => {
    expect(efficiencyCapFor(world.view(), nation)).toBeCloseTo(
      EFFICIENCY_CAP,
      9,
    );
    research("machine_tools");
    research("assembly_line");
    expect(efficiencyCapFor(world.view(), nation)).toBeGreaterThan(
      EFFICIENCY_CAP,
    );
  });

  test("and it survives a snapshot and a restore", () => {
    research("machine_tools");
    const hash = world.stateHash();
    const snapshot = world.snapshot();

    const { world: fresh } = build();
    fresh.restoreFrom(snapshot);
    expect(fresh.view().nations[nation].unlockedTechs).toContain(
      "machine_tools",
    );
    // The hash is the whole content of the restore gate; research has to be
    // inside it, or a world that came back having forgotten a tech would hash
    // identically to one that did not.
    expect(fresh.stateHash()).toBe(hash);
  });
});
