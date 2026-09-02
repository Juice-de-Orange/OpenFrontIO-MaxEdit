import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  Hud,
  type HudActions,
  type HudModel,
} from "../../../src/client/world/ui/Hud";
import type { Province } from "../../../src/shared/map/Province";
import { TerrainType } from "../../../src/shared/map/Terrain";
import type { NationEconomyView } from "../../../src/shared/protocol/Wire";

/**
 * Protocol 17 on the screen: the battle's numbers per day (invariant 9), a
 * ruler beside every other nation's name, the flag in the badge, and where
 * the construction comes from.
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
    researchSlots: [],
    unlockedTechs: [],
    attacks: [],
    regent: { enabled: false, focus: "economy", marketBudget: 0.5 },
    seaTransits: [],
    formations: [],
    zones: [],
    ...over,
  };
}

function province(id: number): Province {
  return {
    id,
    nation: 1,
    neighbours: [],
    airZone: 0,
    seaZone: null,
    terrain: TerrainType.Highland,
    infrastructure: 3,
    buildingSlots: 2,
    resourceDeposits: {},
    tileCount: 100,
    centre: { x: id * 10, y: 5 },
    coastal: false,
    capital: false,
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
        flag: "tl",
        archetype: "builder",
      },
      {
        smallID: 2,
        name: "Otherland",
        ruler: "Alma Falk",
        flag: "ol",
        archetype: "conqueror",
      },
    ],
    provinces: [province(0)],
    controllers: [1],
    owners: [1],
    buildings: new Array<number>(3).fill(0),
    economy: economy(),
    trust: [0, 100, 100],
    agreements: [],
    victory: { holders: null, heldSinceTick: null, winner: null },
    fronts: [],
    invasions: [],
    battles: [],
    tick: 0,
    selected: 0,
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
    disbandFormation: vi.fn(),
    drawAreaFor: vi.fn(),
    chooseNation: vi.fn(),
    changeLanguage: vi.fn(),
  };
}

const panel = (id: string): HTMLElement =>
  document.getElementById(id) as HTMLElement;

let hud: Hud;
beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  hud = new Hud(actions());
});

describe("the battle's numbers", () => {
  const front = { province: 0, attacker: 2, progress: 0.3 };
  const battle = {
    province: 0,
    attacker: 2,
    defender: 1,
    attackerStrength: 2.4,
    defenderStrength: 1.8,
    terrain: 0.25,
    air: -0.1,
    advancePerTick: 0.005,
    attackerLossPerTick: 6,
    defenderLossPerTick: 4,
  };

  test("both strengths, both modifiers signed, the advance and the losses per day", () => {
    hud.update(model({ fronts: [front], battles: [battle] }));
    const text = panel("world-province").textContent ?? "";
    expect(text).toContain("The battle");
    expect(text).toContain("2.40 · 1.80 divisions");
    expect(text).toContain("+25% · -10%");
    expect(text).toContain("+12% a day"); // 0.005 × 24
    expect(text).toContain("144/day · 96.0/day"); // 6 × 24, 4 × 24
    expect(text).not.toMatch(/tick/);
  });

  test("a front without a report this tick shows the front alone", () => {
    hud.update(model({ fronts: [front] }));
    const text = panel("world-province").textContent ?? "";
    expect(text).toContain("Under attack by Otherland");
    expect(text).not.toContain("The battle");
  });
});

describe("personality on the wire", () => {
  test("other nations carry their ruler in the diplomacy list; you do not", () => {
    hud.update(model());
    const options = [...document.querySelectorAll("#world-diplomacy option")];
    const other = options.find((o) => o.textContent?.startsWith("Otherland"));
    expect(other?.textContent).toContain(
      "Otherland · Alma Falk, the conqueror",
    );
    expect(options.some((o) => o.textContent?.includes("Test Ruler"))).toBe(
      false,
    );
  });

  test("the badge carries the flag when the map has one, and none when it does not", () => {
    hud.update(model());
    const flag = document.querySelector<HTMLImageElement>(
      "#world-menu .who img.flag",
    );
    expect(flag?.getAttribute("src")).toBe("/flags/tl.svg");

    hud.update(
      model({
        nations: [
          {
            smallID: 1,
            name: "Testland",
            ruler: "Test Ruler",
            archetype: "builder",
          },
          {
            smallID: 2,
            name: "Otherland",
            ruler: "Alma Falk",
            archetype: "conqueror",
          },
        ],
      }),
    );
    expect(document.querySelector("#world-menu .who img.flag")).toBeNull();
  });

  test("the economy panel says how many civilian factories the construction comes from", () => {
    hud.update(model());
    expect(panel("world-economy").textContent).toContain(
      "from 3 civilian factories",
    );
  });
});
