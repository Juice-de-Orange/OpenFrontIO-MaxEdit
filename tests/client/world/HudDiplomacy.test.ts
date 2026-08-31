import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  Hud,
  type HudActions,
  type HudModel,
} from "../../../src/client/world/ui/Hud";
import { TRUST_COST } from "../../../src/shared/config/diplomacy";
import { TICKS_PER_DAY } from "../../../src/shared/config/time";
import type {
  AgreementView,
  NationEconomyView,
} from "../../../src/shared/protocol/Wire";

/**
 * The diplomacy screen, checked where it can be checked.
 *
 * No browser leg, so nothing here says it *looks* right. What it does say is
 * the part that is a rule rather than a matter of taste: invariant 9's number
 * vocabulary, the exit cost printed on the button that charges it (invariant
 * 3 is worth nothing if the price is only visible after the click), and the
 * one thing a panel rebuilt every tick gets wrong — taking the form out from
 * under a player who is typing into it.
 */
function economy(over: Partial<NationEconomyView> = {}): NationEconomyView {
  const zero = { steel: 0, oil: 0, aluminium: 0, rubber: 0 };
  return {
    nation: 1,
    resources: { ...zero },
    extractionPerTick: { ...zero },
    demandPerTick: { ...zero },
    sufficiency: 1,
    constructionPerTick: 2,
    industryPerTick: 0,
    tradePointsIn: 0,
    tradePointsOut: 0,
    tradeResourcePerTick: { ...zero },
    queue: [],
    stockpile: new Array<number>(10).fill(0),
    manpower: 0,
    manpowerCap: 0,
    productionLines: [],
    divisions: [],
    militaryFactoriesAssigned: 0,
    militaryFactoriesTotal: 0,
    dockyardsAssigned: 0,
    dockyardsTotal: 0,
    researchSlots: [
      { tech: null, progress: 0, unlocked: true },
      { tech: null, progress: 0, unlocked: true },
      { tech: null, progress: 0, unlocked: false },
      { tech: null, progress: 0, unlocked: false },
    ],
    unlockedTechs: [],
    ...over,
  };
}

function agreement(over: Partial<AgreementView> = {}): AgreementView {
  return {
    id: 1,
    type: "trade",
    parties: [1, 2],
    terms: {
      resource: "steel",
      resourcePerTick: 0.5,
      pointsPerTick: 0.25,
    },
    accepted: true,
    noticeAt: null,
    noticeBy: null,
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
    trust: [0, 100, 60],
    agreements: [],
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
  };
}

function panel(): HTMLElement {
  const found = document.getElementById("world-diplomacy");
  expect(found, "the diplomacy panel is not in the document").not.toBeNull();
  return found as HTMLElement;
}

describe("the diplomacy panel", () => {
  let hud: Hud;
  let calls: HudActions;

  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    calls = actions();
    hud = new Hud(calls);
  });

  test("a watching session is shown no diplomacy screen at all", () => {
    hud.update(model({ nation: null, economy: null }));
    expect(panel().hidden).toBe(true);
  });

  test("terms are per in-game day, never per tick", () => {
    hud.update(model({ agreements: [agreement()] }));
    const text = panel().textContent ?? "";
    // 0.5 a tick is 12 a day; 0.25 is 6.
    expect(text).toContain(String(0.5 * TICKS_PER_DAY));
    expect(text).toContain(String(0.25 * TICKS_PER_DAY));
    expect(text).not.toContain("0.5");
  });

  test("the cancel button names the trust it costs", () => {
    hud.update(
      model({ agreements: [agreement({ type: "alliance", terms: null })] }),
    );
    const button = Array.from(panel().querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(String(TRUST_COST.alliance)),
    );
    expect(
      button,
      "no button names the alliance's cancellation cost",
    ).toBeDefined();
    button?.click();
    expect(calls.cancelAgreement).toHaveBeenCalledWith(1);
  });

  test("an agreement under notice says so instead of offering to cancel again", () => {
    hud.update(
      model({ agreements: [agreement({ noticeAt: 100, noticeBy: 2 })] }),
    );
    const text = panel().textContent ?? "";
    expect(text).toContain("Otherland");
    const cancels = Array.from(panel().querySelectorAll("button")).filter((b) =>
      (b.textContent ?? "").includes(String(TRUST_COST.trade)),
    );
    expect(cancels).toHaveLength(0);
  });

  test("an offer made to this nation can be accepted or declined", () => {
    hud.update(
      model({ agreements: [agreement({ accepted: false, parties: [2, 1] })] }),
    );
    const buttons = Array.from(panel().querySelectorAll("button"));
    buttons[0].click();
    expect(calls.acceptAgreement).toHaveBeenCalledWith(1);
    buttons[1].click();
    expect(calls.declineAgreement).toHaveBeenCalledWith(1);
  });

  test("a half-typed proposal survives the next tick", () => {
    hud.update(model());
    const inputs = panel().querySelectorAll("input[type=number]");
    expect(inputs.length).toBeGreaterThan(0);
    const rate = inputs[0] as HTMLInputElement;
    rate.value = "12";

    // A delta arrives, the panel updates, and the player is still mid-
    // sentence. Every other panel is thrown away and redrawn on every tick;
    // this one cannot be, or a rate can never be typed at five seconds a tick.
    hud.update(model({ trust: [0, 95, 60] }));
    const after = panel().querySelectorAll("input[type=number]")[0];
    expect((after as HTMLInputElement).value).toBe("12");
    expect(after).toBe(rate);
  });

  test("the nation picker keeps its selection and still shows fresh trust", () => {
    hud.update(model());
    const who = panel().querySelector("select") as HTMLSelectElement;
    who.value = "2";
    hud.update(model({ trust: [0, 100, 41] }));
    const again = panel().querySelector("select") as HTMLSelectElement;
    expect(again).toBe(who);
    expect(again.value).toBe("2");
    expect(again.textContent).toContain("41");
  });
});
