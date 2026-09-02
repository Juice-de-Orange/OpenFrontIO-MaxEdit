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
 * The war, visible to whoever looks.
 *
 * `fronts` and `invasions` have been public on the wire since phase 9 and
 * reached the client every tick — and went only into the tile painter, so a
 * defender being ground down read nothing in the province panel. The rule
 * checked here: the panel names the attacker and the progress for both
 * sides and for a spectator, shows the holder their own divisions there, and
 * announces a crossing in days rather than ticks (invariant 9).
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
    seaZone: 0,
    terrain: TerrainType.Plains,
    infrastructure: 3,
    buildingSlots: 2,
    resourceDeposits: {},
    tileCount: 100,
    centre: { x: id * 10, y: 5 },
    coastal: true,
    capital: false,
  };
}

function model(over: Partial<HudModel> = {}): HudModel {
  return {
    nation: 1,
    nations: [
      { smallID: 1, name: "Testland", ruler: "Test Ruler" },
      { smallID: 2, name: "Otherland", ruler: "Other Ruler" },
    ],
    provinces: [province(0), province(1)],
    controllers: [1, 2],
    owners: [1, 2],
    buildings: new Array<number>(20).fill(0),
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
    chooseNation: vi.fn(),
  };
}

const text = (): string =>
  document.getElementById("world-province")?.textContent ?? "";

let hud: Hud;
beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  hud = new Hud(actions());
});

describe("a front in the province panel", () => {
  const front = { province: 0, attacker: 2, progress: 0.4 };

  test("the defender is told who is attacking and how far they have got", () => {
    hud.update(model({ fronts: [front] }));
    expect(text()).toContain("Under attack by Otherland");
    expect(text()).toContain("40% of the province taken");
    const bar = document.querySelector<HTMLElement>(
      "#world-province .bar.front > div",
    );
    expect(bar?.style.width).toBe("40%");
  });

  test("and sees their own divisions standing in it, with strength and supply", () => {
    hud.update(
      model({
        fronts: [front],
        economy: economy({
          divisions: [
            { id: 7, provinceId: 0, strength: 0.86, supply: 1 },
            { id: 8, provinceId: 1, strength: 0.5, supply: 0.5 }, // elsewhere
          ],
        }),
      }),
    );
    expect(text()).toContain("Your divisions here");
    expect(text()).toContain("Division 7 · strength 86% · supply 100%");
    expect(text()).not.toContain("Division 8");
  });

  test("the attacker sees the same progress, as their own front", () => {
    hud.update(
      model({ nation: 2, fronts: [front], economy: economy({ nation: 2 }) }),
    );
    expect(text()).toContain("Your front is here");
    expect(text()).toContain("40% of the province taken");
    expect(text()).not.toContain("Under attack by");
  });

  test("a spectator sees it too — fronts are public", () => {
    hud.update(model({ nation: null, economy: null, fronts: [front] }));
    expect(text()).toContain("Under attack by Otherland");
  });

  test("a spent front the wire still carries is not drawn against its new holder", () => {
    hud.update(model({ controllers: [2, 2], fronts: [front] }));
    expect(text()).not.toContain("Under attack");
  });

  test("a quiet province says nothing about war", () => {
    hud.update(model());
    expect(text()).not.toContain("Under attack");
    expect(text()).not.toContain("Invasion");
  });
});

describe("an invasion in the province panel", () => {
  test("the target is warned, in days", () => {
    hud.update(model({ invasions: [{ attacker: 2, to: 0, ticksLeft: 30 }] }));
    expect(text()).toContain("Invasion coming from Otherland");
    expect(text()).toContain("lands in 2 days");
    expect(text()).not.toMatch(/\btick/);
  });

  test("the invader reads it as their own", () => {
    hud.update(
      model({
        nation: 2,
        economy: economy({ nation: 2 }),
        selected: 0,
        invasions: [{ attacker: 2, to: 0, ticksLeft: 12 }],
      }),
    );
    expect(text()).toContain("Your invasion lands here in 1 days");
  });
});
