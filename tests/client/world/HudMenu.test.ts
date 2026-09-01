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

function model(over: Partial<HudModel> = {}): HudModel {
  return {
    nation: 1,
    nations: [
      { smallID: 1, name: "Testland" },
      { smallID: 2, name: "Otherland" },
    ],
    provinces: [],
    controllers: [],
    owners: [],
    buildings: [],
    economy: economy(),
    trust: [0, 100, 100],
    agreements: [],
    victory: { holders: null, heldSinceTick: null, winner: null },
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

  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    hud = new Hud(actions());
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

  test("a watching session gets the bar but every panel stays hidden", () => {
    hud.update(model({ nation: null, economy: null }));
    for (const b of [
      ...(
        document.getElementById("world-menu") as HTMLElement
      ).querySelectorAll("button"),
    ]) {
      b.click();
      expect(shown()).toEqual([]);
    }
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
