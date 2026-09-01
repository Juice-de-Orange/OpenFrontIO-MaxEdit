import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  Hud,
  type HudActions,
  type HudModel,
} from "../../../src/client/world/ui/Hud";
import {
  BUILDING_TYPES,
  buildingIndex,
} from "../../../src/shared/economy/Buildings";
import type { Province } from "../../../src/shared/map/Province";
import { TerrainType } from "../../../src/shared/map/Terrain";
import type { NationEconomyView } from "../../../src/shared/protocol/Wire";

/**
 * The missing entrance.
 *
 * The player opened the deployed world and could not find how to build
 * anything: the build menu lives in the province panel, the province panel
 * exists only after a click on the map, and nothing on screen said so. What
 * is checkable here is the rule, not the looks — that the interface *says*
 * where to build, *says* why a button is disabled, *says* what time it is,
 * and *says* what a technology does. A greyed button with no reason is a
 * puzzle, and this panel had eight of them.
 */
function economy(over: Partial<NationEconomyView> = {}): NationEconomyView {
  const zero = { steel: 0, oil: 0, aluminium: 0, rubber: 0 };
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
    stockpile: new Array<number>(10).fill(0),
    manpower: 5000,
    manpowerCap: 10000,
    productionLines: [],
    divisions: [],
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

function province(over: Partial<Province> = {}): Province {
  return {
    id: 0,
    nation: 1,
    neighbours: [],
    airZone: 0,
    seaZone: null,
    terrain: TerrainType.Plains,
    infrastructure: 3,
    buildingSlots: 2,
    resourceDeposits: {},
    tileCount: 100,
    centre: { x: 5, y: 5 },
    coastal: false,
    capital: false,
    ...over,
  };
}

function model(over: Partial<HudModel> = {}): HudModel {
  return {
    nation: 1,
    nations: [
      { smallID: 1, name: "Testland" },
      { smallID: 2, name: "Otherland" },
    ],
    provinces: [province()],
    controllers: [1],
    owners: [1],
    buildings: new Array<number>(BUILDING_TYPES.length).fill(0),
    economy: economy(),
    trust: [0, 100, 100],
    agreements: [],
    victory: { holders: null, heldSinceTick: null, winner: null },
    fronts: [],
    invasions: [],
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
    chooseNation: vi.fn(),
  };
}

function panel(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

/** The build button whose label starts with the building's English name. */
function buildButton(label: string): HTMLButtonElement {
  const buttons = [...panel("world-province").querySelectorAll("button")];
  const found = buttons.find((b) => b.textContent?.startsWith(label));
  if (found === undefined) throw new Error(`no build button "${label}"`);
  return found;
}

function menuButton(label: string): HTMLButtonElement {
  const found = [...panel("world-menu").querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (found === undefined) throw new Error(`no menu button "${label}"`);
  return found;
}

let hud: Hud;

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  hud = new Hud(actions());
});

describe("where to build", () => {
  test("an empty queue says to click a province on the map", () => {
    hud.update(model());
    menuButton("Construction queue").click();
    const text = panel("world-queue").textContent ?? "";
    expect(text).toContain("Nothing under construction.");
    expect(text).toContain("click one of your provinces on the map");
  });

  test("the economy panel says so too — it is the panel that opens first", () => {
    hud.update(model());
    expect(panel("world-economy").textContent).toContain(
      "click one of your provinces on the map",
    );
  });

  test("but not to a spectator, who has nothing to build with", () => {
    hud.update(model({ nation: null, economy: null }));
    expect(panel("world-economy").textContent ?? "").not.toContain(
      "click one of your provinces",
    );
  });
});

describe("why a button is disabled", () => {
  test("a full province says 'no free building slot' on the button itself", () => {
    const buildings = new Array<number>(BUILDING_TYPES.length).fill(0);
    buildings[buildingIndex("civilian_factory")] = 2; // both slots taken
    hud.update(model({ buildings }));
    const button = buildButton("Civilian factory");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("no free building slot");
    expect(button.title).toBe("no free building slot");
  });

  test("a queued order holds its slot, exactly as the server counts it", () => {
    const buildings = new Array<number>(BUILDING_TYPES.length).fill(0);
    buildings[buildingIndex("civilian_factory")] = 1; // one built...
    hud.update(
      model({
        buildings,
        economy: economy({
          queue: [
            { id: 7, provinceId: 0, building: "military_factory", progress: 0 },
          ], // ...one queued: the second slot is spoken for
        }),
      }),
    );
    expect(buildButton("Civilian factory").disabled).toBe(true);
    expect(buildButton("Civilian factory").textContent).toContain(
      "no free building slot",
    );
    // The slot row agrees with the button.
    expect(panel("world-province").textContent).toContain("2 / 2");
  });

  test("an inland province says a dockyard needs a coast", () => {
    hud.update(model());
    const button = buildButton("Dockyard");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("needs a coast");
    // An enabled button carries no reason at all.
    const factory = buildButton("Civilian factory");
    expect(factory.disabled).toBe(false);
    expect(factory.querySelector(".why")).toBeNull();
  });

  test("infrastructure at its cap says so, counting the province's own level", () => {
    const buildings = new Array<number>(BUILDING_TYPES.length).fill(0);
    buildings[buildingIndex("infrastructure")] = 7; // 3 base + 7 built = 10
    hud.update(model({ buildings }));
    const button = buildButton("Infrastructure level");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("at the limit of 10");
  });

  test("a province held but not owned shows the menu, closed, with the reason", () => {
    hud.update(model({ owners: [2] })); // controller 1, owner 2: occupied
    const text = panel("world-province").textContent ?? "";
    expect(text).toContain("Build");
    for (const label of ["Civilian factory", "Dockyard", "Raise a division"]) {
      const button = buildButton(label);
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain("occupied territory");
    }
  });

  test("too little manpower names the price and the purse", () => {
    hud.update(model({ economy: economy({ manpower: 120 }) }));
    const button = buildButton("Raise a division");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/needs \d+ manpower, you have 120/);
  });
});

describe("the clock", () => {
  test("the bar shows the in-game day and hour, from the tick alone", () => {
    hud.update(model({ tick: 24 * 158 + 14 }));
    const clock = panel("world-menu").querySelector(".clock");
    expect(clock?.textContent).toBe("Day 158 · 14:00");
  });

  test("and pads the hour, so the clock does not jump width every hour", () => {
    hud.update(model({ tick: 3 }));
    expect(panel("world-menu").querySelector(".clock")?.textContent).toBe(
      "Day 0 · 03:00",
    );
  });
});

describe("research explains itself", () => {
  test("the panel says what a slot is and what it costs", () => {
    hud.update(model());
    menuButton("Research").click();
    expect(panel("world-research").textContent).toContain(
      "Each slot researches one technology at a time",
    );
  });

  test("every tech says what it does, as a signed percentage", () => {
    hud.update(model());
    menuButton("Research").click();
    const buttons = [...panel("world-research").querySelectorAll("button")];
    const machineTools = buttons.find((b) =>
      b.textContent?.startsWith("Machine tools"),
    );
    expect(machineTools?.querySelector(".effect")?.textContent).toBe(
      "+10% factory output",
    );
    const bureau = buttons.find((b) =>
      b.textContent?.startsWith("Research bureau"),
    );
    expect(bureau?.querySelector(".effect")?.textContent).toBe(
      "+1 research slot",
    );
    const entrenchment = buttons.find((b) =>
      b.textContent?.startsWith("Entrenchment"),
    );
    expect(entrenchment?.querySelector(".effect")?.textContent).toBe(
      "-25% defender losses",
    );
  });

  test("a tech with missing prerequisites says which, on the button", () => {
    hud.update(model());
    menuButton("Research").click();
    const buttons = [...panel("world-research").querySelectorAll("button")];
    const deepMining = buttons.find((b) =>
      b.textContent?.startsWith("Deep mining"),
    );
    expect(deepMining?.disabled).toBe(true);
    expect(deepMining?.querySelector(".why")?.textContent).toBe(
      "needs Excavation",
    );
  });

  test("with every slot busy, an available tech says 'no free slot'", () => {
    hud.update(
      model({
        economy: economy({
          researchSlots: [
            { tech: "machine_tools", progress: 10, unlocked: true },
            { tech: "excavation", progress: 10, unlocked: true },
            { tech: null, progress: 0, unlocked: false },
            { tech: null, progress: 0, unlocked: false },
          ],
        }),
      }),
    );
    menuButton("Research").click();
    const buttons = [...panel("world-research").querySelectorAll("button")];
    const concrete = buttons.find((b) =>
      b.textContent?.startsWith("Reinforced concrete"),
    );
    expect(concrete?.disabled).toBe(true);
    expect(concrete?.querySelector(".why")?.textContent).toBe("no free slot");
  });
});
