import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  Hud,
  type HudActions,
  type HudModel,
} from "../../../src/client/world/ui/Hud";
import {
  currentLanguage,
  setLanguage,
  t,
  type StringKey,
} from "../../../src/client/world/ui/strings";
import type { Province } from "../../../src/shared/map/Province";
import { TerrainType } from "../../../src/shared/map/Terrain";
import type { NationEconomyView } from "../../../src/shared/protocol/Wire";

/**
 * The info affordance, and the airfield rule made visible.
 *
 * "Resources covered 60%" tells a new player nothing. A circled i beside it
 * opens the explanation inline in the panel — and the rule worth checking is
 * that the explanation *stays* open across the per-tick rebuild, because the
 * panels are rebuilt by `replaceChildren` every five seconds and a state held
 * in the DOM would close itself. The other rule: a zone a wing cannot reach
 * is greyed in the dropdown with the same function the server refuses with.
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

/** Four provinces in a row, in air zones 0, 0, 1, 2: zone 2 is out of reach from zone 0. */
function provinces(): Province[] {
  const zones = [0, 0, 1, 2];
  return zones.map((airZone, id) => ({
    id,
    nation: 1,
    neighbours: [id - 1, id + 1].filter((n) => n >= 0 && n < zones.length),
    airZone,
    seaZone: null,
    terrain: TerrainType.Plains,
    infrastructure: 3,
    buildingSlots: 2,
    resourceDeposits: {},
    tileCount: 100,
    centre: { x: id, y: 0 },
    coastal: false,
    capital: id === 0,
  }));
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
      {
        smallID: 2,
        name: "Otherland",
        ruler: "Other Ruler",
        archetype: "warden",
      },
    ],
    provinces: provinces(),
    controllers: [1, 1, 1, 1],
    owners: [1, 1, 1, 1],
    buildings: new Array<number>(40).fill(0),
    economy: economy(),
    trust: [0, 100, 100],
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
    disbandFormation: vi.fn(),
    chooseNation: vi.fn(),
    changeLanguage: vi.fn(),
  };
}

function panel(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function infoButton(key: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `button.info[data-help="${key}"]`,
  );
  if (found === null) throw new Error(`no info button for ${key}`);
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

describe("the circled i", () => {
  test("the economy panel's rows each carry one, and nothing is open at first", () => {
    hud.update(model());
    const economyPanel = panel("world-economy");
    expect(
      economyPanel.querySelectorAll("button.info").length,
    ).toBeGreaterThanOrEqual(4);
    expect(economyPanel.querySelector(".help")).toBeNull();
  });

  test("a click opens the explanation inline, beside the number it explains", () => {
    hud.update(model());
    infoButton("help.economy.supplyRatio").click();
    const help = panel("world-economy").querySelector(".help");
    expect(help?.textContent).toContain("Nothing ever stops for want of steel");
    // Right under its row, not at the foot of the panel.
    const row = infoButton("help.economy.supplyRatio").closest(".row");
    expect(row?.nextElementSibling).toBe(help);
    expect(
      infoButton("help.economy.supplyRatio").getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("and stays open across the per-tick rebuild — the state is not in the DOM", () => {
    hud.update(model());
    infoButton("help.economy.construction").click();
    hud.update(model({ tick: 1 }));
    hud.update(model({ tick: 2 }));
    expect(
      panel("world-economy").querySelector(".help")?.textContent,
    ).toContain("civilian factories");
  });

  test("a second click closes it, and only it", () => {
    hud.update(model());
    infoButton("help.economy.construction").click();
    infoButton("help.economy.industry").click();
    expect(panel("world-economy").querySelectorAll(".help").length).toBe(2);
    infoButton("help.economy.construction").click();
    const open = [...panel("world-economy").querySelectorAll(".help")];
    expect(open.length).toBe(1);
    expect(open[0].textContent).toContain("military factories");
  });

  test("the province and production panels carry theirs on the rows they explain", () => {
    hud.update(model({ selected: 0 }));
    const province = panel("world-province");
    expect(
      province.querySelectorAll("button.info").length,
    ).toBeGreaterThanOrEqual(5);
    infoButton("help.province.terrain").click();
    expect(province.querySelector(".help")?.textContent).toContain(
      "Terrain multiplies the defence",
    );
    menuButton("Production").click();
    infoButton("help.production.manpower").click();
    expect(
      panel("world-production").querySelector(".help")?.textContent,
    ).toContain("population-scaled cap");
  });

  test("research and the air panel have theirs too", () => {
    hud.update(model());
    menuButton("Research").click();
    infoButton("help.research.slots").click();
    expect(
      panel("world-research").querySelector(".help")?.textContent,
    ).toContain("costs nothing but the slot");
    menuButton("Air and sea").click();
    infoButton("help.air.missions").click();
    expect(panel("world-air").querySelector(".help")?.textContent).toContain(
      "Four missions for the sky",
    );
    infoButton("help.air.missions").click();
    infoButton("help.air.base").click();
    expect(panel("world-air").querySelector(".help")?.textContent).toContain(
      "Build the base first",
    );
  });
});

describe("the airfield rule, visible", () => {
  const wing = {
    id: 5,
    template: "fighter_wing" as const,
    baseProvinceId: 0,
    zone: null,
    mission: null,
    strength: 1,
  };
  const zones = [0, 1, 2].map((zone) => ({
    zone,
    kind: "air" as const,
    superiority: 0.5,
    contested: false,
    ownStrength: 0,
  }));

  test("a zone the wing cannot reach is greyed in the dropdown and says so", () => {
    hud.update(model({ economy: economy({ formations: [wing], zones }) }));
    menuButton("Air and sea").click();
    const options = [...panel("world-air").querySelectorAll("select")][1]
      .options;
    const byZone = new Map(
      [...options].map((o) => [
        o.value,
        { disabled: o.disabled, label: o.textContent },
      ]),
    );
    expect(byZone.get("0")?.disabled).toBe(false); // home
    expect(byZone.get("1")?.disabled).toBe(false); // borders home
    expect(byZone.get("2")?.disabled).toBe(true); // two zones out
    expect(byZone.get("2")?.label).toContain("out of reach");
    expect(byZone.get("1")?.label).not.toContain("out of reach");
  });

  test("the panel states the rule in words as well", () => {
    hud.update(model({ economy: economy({ formations: [wing], zones }) }));
    menuButton("Air and sea").click();
    expect(panel("world-air").textContent).toContain(
      "flies over its base's zone and the zones next to it",
    );
  });
});

describe("the string catalogue", () => {
  test("a missing key renders as the key instead of taking the HUD down", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(t("no.such.key" as StringKey)).toBe("no.such.key");
    expect(t("no.such.key" as StringKey)).toBe("no.such.key");
    expect(warn).toHaveBeenCalledTimes(1); // once, not every tick
    warn.mockRestore();
  });

  test("no string puts a tick count on screen (invariant 9)", () => {
    // The two that did: production.atSea and hud.orderAccepted.
    expect(t("production.atSea", { id: 3, days: 2 })).toBe(
      "Division 3 · at sea, 2 days out",
    );
    expect(t("hud.orderAccepted")).toBe("Order accepted.");
    expect(t("hud.orderAccepted")).not.toMatch(/\d/);
  });
});

describe("the language picker", () => {
  test("the bar offers both languages and hands the choice to the client", () => {
    const wired = actions();
    // A second HUD beside the one beforeEach built would leave two bars, and
    // the query below would find the wrong one.
    document.body.replaceChildren();
    document.head.replaceChildren();
    hud = new Hud(wired);
    hud.update(model());
    const picker = document.querySelector<HTMLSelectElement>(
      "#world-menu select.lang",
    );
    expect(picker).not.toBeNull();
    expect([...(picker?.options ?? [])].map((o) => o.value)).toEqual([
      "en",
      "de",
    ]);
    expect(picker?.value).toBe("en"); // jsdom's navigator.language is en-US
    if (picker === null) throw new Error("no picker");
    picker.value = "de";
    picker.dispatchEvent(new Event("change"));
    expect(wired.changeLanguage).toHaveBeenCalledWith("de");
  });

  test("setLanguage switches the catalogue and remembers the choice", () => {
    setLanguage("de");
    try {
      expect(currentLanguage()).toBe("de");
      expect(t("queue.title")).toBe("Bauschlange");
      expect(localStorage.getItem("world.language")).toBe("de");
    } finally {
      setLanguage("en");
      localStorage.removeItem("world.language");
    }
    expect(t("queue.title")).toBe("Construction queue");
  });
});
