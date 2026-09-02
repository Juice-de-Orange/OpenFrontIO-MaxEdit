import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  Hud,
  type HudActions,
  type HudModel,
} from "../../../src/client/world/ui/Hud";
import { DIVISION_MANPOWER } from "../../../src/shared/config/rates";
import { TICKS_PER_DAY } from "../../../src/shared/config/time";
import { TerrainType } from "../../../src/shared/map/Terrain";
import type { NationEconomyView } from "../../../src/shared/protocol/Wire";

/**
 * The production screen, checked where it can be checked.
 *
 * This project has no automated browser leg, so nothing here says the panel
 * *looks* right. What it does say is the part that is a rule rather than a
 * matter of taste: invariant 9's number vocabulary, and the one control that
 * can cost a player an in-game month by accident (§6.2's switch) naming its
 * price on its own label.
 */
function economy(over: Partial<NationEconomyView> = {}): NationEconomyView {
  const zero = { material: 0 };
  return {
    nation: 1,
    resources: { ...zero },
    extractionPerTick: { ...zero },
    demandPerTick: { ...zero },
    sufficiency: 1,
    constructionPerTick: 0,
    industryPerTick: 0,
    tradePointsIn: 0,
    tradePointsOut: 0,
    tradeResourcePerTick: { ...zero },
    queue: [],
    stockpile: new Array<number>(3).fill(0),
    manpower: 5000,
    manpowerCap: 10000,
    productionLines: [],
    divisions: [],
    civilianFactories: 3,
    militaryFactoriesAssigned: 0,
    militaryFactoriesTotal: 4,
    dockyardsAssigned: 0,
    dockyardsTotal: 0,
    researchSlots: [
      { tech: null, progress: 0, unlocked: true },
      { tech: null, progress: 0, unlocked: true },
      { tech: null, progress: 0, unlocked: false },
      { tech: null, progress: 0, unlocked: false },
    ],
    unlockedTechs: [],
    attacks: [],
    regent: { enabled: false, focus: "economy", marketBudget: 0.5 },
    seaTransits: [],
    formations: [],
    zones: [],
    ...over,
  };
}

function model(over: Partial<HudModel> = {}): HudModel {
  return {
    nation: 1,
    nations: [
      {
        smallID: 1,
        name: "Testland",
        ruler: "Test Ruler",
        archetype: "builder",
      },
    ],
    provinces: [],
    controllers: [],
    owners: [],
    buildings: [],
    economy: economy(),
    trust: [0, 100],
    agreements: [],
    victory: { holders: null, heldSinceTick: null, winner: null },
    fronts: [],
    invasions: [],
    battles: [],
    tick: 0,
    selected: null,
    ...over,
  };
}

function actions(): HudActions {
  return {
    claim: vi.fn(),
    build: vi.fn(),
    cancel: vi.fn(),
    openLine: vi.fn(),
    closeLine: vi.fn(),
    assignFactories: vi.fn(),
    switchLine: vi.fn(),
    raiseDivision: vi.fn(),
    startResearch: vi.fn(),
    cancelResearch: vi.fn(),
    propose: vi.fn(),
    acceptAgreement: vi.fn(),
    declineAgreement: vi.fn(),
    cancelAgreement: vi.fn(),
    setMarketOrder: vi.fn(),
    cancelAttack: vi.fn(),
    navalInvade: vi.fn(),
    configureRegent: vi.fn(),
    raiseFormation: vi.fn(),
    assignFormation: vi.fn(),
    drawAreaFor: vi.fn(),
    disbandFormation: vi.fn(),
    chooseNation: vi.fn(),
    changeLanguage: vi.fn(),
  };
}

function panel(): HTMLElement {
  const found = document.getElementById("world-production");
  expect(found, "the production panel is not in the document").not.toBeNull();
  return found as HTMLElement;
}

describe("the production panel", () => {
  let hud: Hud;
  let calls: HudActions;

  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    calls = actions();
    hud = new Hud(calls);
  });

  test("a watching session is shown no production screen at all", () => {
    hud.update(model({ nation: null, economy: null }));
    expect(panel().hidden).toBe(true);
  });

  test("efficiency is a percentage and output is per in-game day", () => {
    hud.update(
      model({
        economy: economy({
          militaryFactoriesAssigned: 2,
          productionLines: [
            {
              id: 1,
              equipment: "infantry",
              factories: 2,
              efficiency: 0.4,
              outputPerTick: 0.5,
            },
          ],
        }),
      }),
    );
    const text = panel().textContent ?? "";
    expect(text).toContain("40%");
    // Invariant 9: never a per-tick figure. 0.5 a tick is 12 a day.
    expect(text).toContain(String(0.5 * TICKS_PER_DAY));
    expect(text).not.toContain("0.5");
  });

  test("the switch control names the efficiency it would throw away", () => {
    hud.update(
      model({
        economy: economy({
          productionLines: [
            {
              id: 7,
              equipment: "infantry",
              factories: 1,
              efficiency: 0.76,
              outputPerTick: 0.3,
            },
          ],
        }),
      }),
    );
    const buttons = [...panel().querySelectorAll("button")];
    const swap = buttons.find((b) => b.textContent?.includes("76%"));
    expect(
      swap,
      "no control tells the player what the switch costs",
    ).toBeDefined();
  });

  test("a factory button sends an absolute count, never a delta", () => {
    hud.update(
      model({
        economy: economy({
          militaryFactoriesAssigned: 2,
          productionLines: [
            {
              id: 3,
              equipment: "infantry",
              factories: 2,
              efficiency: 0.2,
              outputPerTick: 0.1,
            },
          ],
        }),
      }),
    );
    const buttons = [...panel().querySelectorAll("button")];
    const more = buttons.find((b) => b.textContent?.includes("+"));
    expect(more).toBeDefined();
    more?.click();
    expect(calls.assignFactories).toHaveBeenCalledWith(3, 3);
  });

  test("the last factory can be taken off a line but not one that has none", () => {
    hud.update(
      model({
        economy: economy({
          productionLines: [
            {
              id: 4,
              equipment: "infantry",
              factories: 0,
              efficiency: 0.1,
              outputPerTick: 0,
            },
          ],
        }),
      }),
    );
    const buttons = [...panel().querySelectorAll("button")];
    const less = buttons.find((b) => b.textContent?.includes("−"));
    expect(less?.disabled).toBe(true);
  });
});

describe("raising a division", () => {
  const province = {
    id: 0,
    nation: 1,
    neighbours: [],
    airZone: 0,
    seaZone: null,
    terrain: TerrainType.Plains,
    infrastructure: 5,
    buildingSlots: 6,
    resourceDeposits: {},
    tileCount: 900,
    centre: { x: 0, y: 0 },
    coastal: false,
    capital: true,
  };

  function withManpower(manpower: number): {
    hud: Hud;
    calls: HudActions;
  } {
    document.body.replaceChildren();
    document.head.replaceChildren();
    const calls = actions();
    const hud = new Hud(calls);
    hud.update(
      model({
        provinces: [province],
        controllers: [1],
        owners: [1],
        buildings: new Array<number>(3).fill(0),
        selected: 0,
        economy: economy({ manpower }),
      }),
    );
    return { hud, calls };
  }

  function raiseButton(): HTMLButtonElement | undefined {
    const panelEl = document.getElementById("world-province");
    return [...(panelEl?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes(String(DIVISION_MANPOWER)),
    );
  }

  test("a nation that can afford a division may raise one", () => {
    const { calls } = withManpower(DIVISION_MANPOWER);
    const button = raiseButton();
    expect(button?.disabled).toBe(false);
    button?.click();
    expect(calls.raiseDivision).toHaveBeenCalledWith(0);
  });

  // Degrade, never hard-block (invariant 2) is about *rates*; a division is a
  // discrete thing and cannot be raised at 40%. The honest UI is a button that
  // is visibly there and visibly unaffordable, with the price on it.
  test("and one that cannot afford it sees the price, greyed out", () => {
    withManpower(DIVISION_MANPOWER - 1);
    expect(raiseButton()?.disabled).toBe(true);
  });
});

/**
 * The HUD is inserted before the canvas and both are `position: fixed;
 * inset: 0`, so without an explicit stacking order the map paints over every
 * panel — a HUD that is built, populated and invisible. jsdom has no layout to
 * assert against, so this asserts the rule that prevents it.
 */
describe("the HUD's stacking order", () => {
  test("#world-hud declares a z-index, or the canvas covers it", () => {
    new Hud(actions());
    const css = Array.from(document.head.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    const block = /#world-hud\s*\{([^}]*)\}/.exec(css);
    expect(block, "no #world-hud rule in the HUD's stylesheet").not.toBeNull();
    expect(block?.[1]).toMatch(/z-index:\s*\d+/);
  });
});
