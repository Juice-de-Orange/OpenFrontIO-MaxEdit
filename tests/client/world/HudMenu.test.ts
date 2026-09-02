import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  Hud,
  type HudActions,
  type HudModel,
} from "../../../src/client/world/ui/Hud";
import type { NationEconomyView } from "../../../src/shared/protocol/Wire";

/**
 * The menu bar: one panel at a time, and the map underneath stays visible.
 *
 * Six always-open panels covered half the map, which was the first thing
 * anyone noticed about the game. What is checkable here is the rule, not the
 * looks: exactly one menu panel is ever shown, a second click closes it, and
 * the built-once forms (diplomacy, air) keep their identity across panel
 * switches — the player's half-typed rate must survive tabbing away.
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
    provinces: [],
    controllers: [],
    owners: [],
    buildings: [],
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

const MENU_PANELS = [
  "world-economy",
  "world-queue",
  "world-production",
  "world-research",
  "world-diplomacy",
  "world-air",
] as const;

function shown(): string[] {
  return MENU_PANELS.filter(
    (id) => (document.getElementById(id) as HTMLElement).hidden === false,
  );
}

function button(label: string): HTMLButtonElement {
  const bar = document.getElementById("world-menu");
  expect(bar, "the menu bar is not in the document").not.toBeNull();
  const found = [...(bar as HTMLElement).querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  expect(found, `no menu button labelled ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}

describe("the menu bar", () => {
  let hud: Hud;
  // Kept, not just passed: the spectator panel's way out is an action, and an
  // action nobody can see called is an action nobody can prove is wired.
  let wired: HudActions;

  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    wired = actions();
    hud = new Hud(wired);
  });

  test("at most one menu panel is ever shown", () => {
    hud.update(model());
    expect(shown().length).toBeLessThanOrEqual(1);

    for (const b of [
      ...(
        document.getElementById("world-menu") as HTMLElement
      ).querySelectorAll("button"),
    ]) {
      b.click();
      expect(shown().length).toBeLessThanOrEqual(1);
    }
  });

  test("a click opens the panel and a second click closes it", () => {
    hud.update(model());
    const research = button("Research");
    research.click();
    expect(shown()).toEqual(["world-research"]);
    expect(research.getAttribute("aria-pressed")).toBe("true");
    research.click();
    expect(shown()).toEqual([]);
    expect(research.getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * This used to assert the opposite — that a watching session's panels all
   * stayed hidden — and that was the bug rather than the contract. Every panel
   * hiding itself without a nation meant a spectator pressing a menu button
   * got no panel, no message and no reason, which is what a broken button
   * looks like. It was reported as "I cannot click any of the menu items".
   */
  test("a watching session gets an answer, not an empty screen", () => {
    hud.update(model({ nation: null, economy: null }));
    const buttons = [
      ...(
        document.getElementById("world-menu") as HTMLElement
      ).querySelectorAll("button"),
    ];
    expect(buttons.length).toBe(6);

    for (const b of buttons) {
      // A click on the open panel closes it — that is the toggle working, not
      // the spectator case. Make sure this one ends up open.
      if (b.getAttribute("aria-pressed") === "true") b.click();
      b.click();
      expect(b.getAttribute("aria-pressed")).toBe("true");
      // Exactly one panel, and it explains itself rather than being blank.
      expect(shown().length).toBe(1);
      const panel = document.getElementById(shown()[0]) as HTMLElement;
      expect(panel.textContent).toContain("Watching");
      expect(panel.querySelector("button")).not.toBeNull();
    }
  });

  test("the spectator panel offers the chooser, and it is wired", () => {
    hud.update(model({ nation: null, economy: null }));
    button("Economy").click();
    const panel = document.getElementById("world-economy") as HTMLElement;
    const choose = panel.querySelector("button") as HTMLButtonElement;
    expect(choose.textContent).toBe("Choose a nation");
    choose.click();
    expect(wired.chooseNation).toHaveBeenCalledTimes(1);
  });

  test("the bar says which nation you are", () => {
    hud.update(model());
    const who = document.querySelector("#world-menu .who") as HTMLElement;
    expect(who.textContent).not.toBe("");
    expect(who.querySelector(".swatch")).not.toBeNull();

    hud.update(model({ nation: null, economy: null }));
    expect(who.textContent).toContain("Watching");
    expect(who.querySelector(".swatch")).toBeNull();
  });

  test("the diplomacy form keeps its identity across panel switches", () => {
    hud.update(model());
    button("Diplomacy").click();
    const before = document.querySelector("#world-diplomacy select");
    expect(before).not.toBeNull();

    button("Production").click();
    button("Diplomacy").click();
    hud.update(model());
    const after = document.querySelector("#world-diplomacy select");
    // toBe-identity: a rebuilt form clears what the player was typing and
    // takes the focus with it every switch.
    expect(after).toBe(before);
  });

  test("the province panel is not part of the rotation", () => {
    hud.update(
      model({
        provinces: [],
        selected: null,
      }),
    );
    const province = document.getElementById("world-province") as HTMLElement;
    // No selection: hidden, whatever the menu does.
    button("Economy").click();
    expect(province.hidden).toBe(true);
  });
});
