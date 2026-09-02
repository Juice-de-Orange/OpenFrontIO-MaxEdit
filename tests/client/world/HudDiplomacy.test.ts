import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  Hud,
  type HudActions,
  type HudModel,
} from "../../../src/client/world/ui/Hud";
import { TRUST_COST } from "../../../src/shared/config/diplomacy";
import { TICKS_PER_DAY } from "../../../src/shared/config/time";
import {
  CommandBodySchema,
  type AgreementView,
  type NationEconomyView,
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
    civilianFactories: 3,
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
    attacks: [],
    regent: { enabled: false, focus: "economy", marketBudget: 0.5 },
    seaTransits: [],
    formations: [],
    zones: [],
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
      { smallID: 1, name: "Testland", ruler: "Test Ruler" },
      { smallID: 2, name: "Otherland", ruler: "Other Ruler" },
    ],
    provinces: [],
    controllers: [],
    owners: [],
    buildings: [],
    economy: economy(),
    trust: [0, 100, 60],
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

  test("the economy panel shows what the queue gets, not what the factories made", () => {
    hud.update(
      model({
        economy: economy({
          constructionPerTick: 2,
          tradePointsIn: 0,
          tradePointsOut: 1,
          queue: [
            {
              id: 1,
              provinceId: 3,
              building: "civilian_factory",
              progress: 0,
            },
          ],
        }),
      }),
    );
    const panelText =
      document.getElementById("world-economy")?.textContent ?? "";
    // One point a tick after paying for imports, so 24 a day and not 48.
    expect(panelText).toContain(String(1 * TICKS_PER_DAY));
    expect(panelText).not.toContain(String(2 * TICKS_PER_DAY));

    // And the queue's estimate is built from the same figure: 360 points at
    // 24 a day is 15 days, not the 8 the gross rate would have promised.
    const queueText = document.getElementById("world-queue")?.textContent ?? "";
    expect(queueText).toContain("15");
  });

  test("a trade offer sent with the form's own defaults is a valid command", () => {
    hud.update(model());
    // The type picker is the second select in the form, and "trade" is not
    // its default — a player has to choose it, which is the whole of what
    // this takes: choose it, and press send.
    const selects = panel().querySelectorAll("select");
    const what = selects[1] as HTMLSelectElement;
    what.value = "trade";
    what.dispatchEvent(new Event("change"));
    const send = Array.from(panel().querySelectorAll("button")).find(
      (b) => b.textContent === "Send the offer",
    );
    expect(send, "no send button in the proposal form").toBeDefined();
    send?.click();
    expect(calls.propose).toHaveBeenCalled();
    const [to, type, terms] = (calls.propose as unknown as Mock).mock.calls[0];

    // **The command has to pass the wire's own schema.** It is not validated
    // on the way out (`encodeClient` is a `JSON.stringify`), and the server
    // treats a schema failure as a protocol violation: it closes the socket
    // with `CloseCode.Malformed`, and `WorldSocket` stops reconnecting on that
    // code. A form whose defaults cannot be sent therefore throws the player
    // out of a running world for pressing a button the UI offered them.
    const parsed = CommandBodySchema.safeParse({
      kind: "propose_agreement",
      to,
      type,
      terms,
    });
    expect(
      parsed.success,
      `the form's own defaults do not survive the wire: ${JSON.stringify(
        parsed.success ? {} : parsed.error.issues,
      )}`,
    ).toBe(true);
  });

  test("a rate typed past the ceiling is still a valid command", () => {
    hud.update(model());
    const what = panel().querySelectorAll("select")[1] as HTMLSelectElement;
    what.value = "trade";
    what.dispatchEvent(new Event("change"));
    const inputs = panel().querySelectorAll("input[type=number]");
    (inputs[0] as HTMLInputElement).value = "9999";
    (inputs[1] as HTMLInputElement).value = "-5";
    const send = Array.from(panel().querySelectorAll("button")).find(
      (b) => b.textContent === "Send the offer",
    );
    send?.click();
    const calls0 = (calls.propose as unknown as Mock).mock.calls[0];
    const parsed = CommandBodySchema.safeParse({
      kind: "propose_agreement",
      to: calls0[0],
      type: calls0[1],
      terms: calls0[2],
    });
    // `min` and `max` on a number input are advisory outside a form submit.
    // Whatever the player types, what leaves has to be sendable.
    expect(parsed.success).toBe(true);
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
