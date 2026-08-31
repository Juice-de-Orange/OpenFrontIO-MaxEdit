/**
 * The world client's first screen: economy, province, construction queue.
 *
 * Plain DOM, no framework. The world client is one page with three panels and
 * no routing; `lit` is a dependency of the quarantined legacy client and
 * reaching for it here would be the first step to reviving that tree. When
 * there are twenty screens this becomes a real question — it is not one yet.
 *
 * **It lives outside `render/` and that is enforced.**
 * `tests/architecture/RenderBoundary.test.ts` fails if the renderer imports
 * anything from here, which is what keeps the renderer a pure consumer of
 * `FrameData`.
 *
 * The HUD is a function of the model and rebuilds the panels it needs on
 * every update. Rebuilding a few dozen elements once a tick is not worth
 * optimising; keeping the panels a pure function of the state is worth a great
 * deal, because it is what makes "the client derives no state" checkable.
 */

import { WING_MANPOWER } from "src/shared/config/air";
import {
  AGREEMENT_TYPES,
  MARKET_BUY_POINTS,
  MARKET_SELL_POINTS,
  MAX_MARKET_PER_TICK,
  MAX_TRADE_POINTS_PER_TICK,
  MAX_TRADE_RESOURCE_PER_TICK,
  TRUST_COST,
  type AgreementType,
} from "src/shared/config/diplomacy";
import { RESOURCES, type Resource } from "src/shared/config/provinces";
import { DIVISION_MANPOWER } from "src/shared/config/rates";
import {
  isAvailable,
  TECH_IDS,
  TECHS,
  type TechId,
} from "src/shared/config/techs";
import { TICKS_PER_DAY } from "src/shared/config/time";
import {
  BUILDING_TYPES,
  buildingIndex,
  BUILDINGS,
  type BuildingType,
} from "src/shared/economy/Buildings";
import {
  EQUIPMENT,
  EQUIPMENT_TYPES,
  type EquipmentType,
} from "src/shared/economy/Equipment";
import {
  AIR_MISSIONS,
  FORMATION_TEMPLATES,
  FORMATIONS,
  type FormationTemplate,
  type Mission,
} from "src/shared/economy/Formations";
import type { Province } from "src/shared/map/Province";
import { TerrainType } from "src/shared/map/Terrain";
import type {
  AgreementView,
  NationEconomyView,
  NationStatic,
  TradeTermsView,
} from "src/shared/protocol/Wire";
import { amount, daysRemaining, fraction, perDay, share } from "./Format";
import { t, type StringKey } from "./strings";

const STYLE = `
#world-hud, #world-hud * { box-sizing: border-box; }
#world-hud {
  position: fixed; inset: 0; pointer-events: none;
  font: 13px/1.45 system-ui, sans-serif; color: #eee;
}
#world-hud .panel {
  position: absolute; pointer-events: auto;
  background: rgba(18,18,20,.88); border: 1px solid rgba(255,255,255,.12);
  border-radius: 6px; padding: .6rem .75rem; backdrop-filter: blur(3px);
  max-height: calc(100vh - 2rem); overflow-y: auto;
}
#world-hud h2 {
  margin: 0 0 .4rem; font-size: 11px; font-weight: 600;
  letter-spacing: .08em; text-transform: uppercase; color: #9aa4b2;
}
#world-hud .row { display: flex; justify-content: space-between; gap: 1rem; }
#world-hud .row span:last-child { color: #fff; font-variant-numeric: tabular-nums; }
#world-hud .muted { color: #9aa4b2; }
#world-economy { top: 1rem; left: 1rem; width: 15rem; }
#world-queue { top: 1rem; left: 17.5rem; width: 16rem; }
#world-province { top: 1rem; right: 1rem; width: 17rem; }
#world-production { bottom: 1rem; left: 1rem; width: 20rem; max-height: 60vh; }
#world-research { bottom: 1rem; right: 1rem; width: 18rem; max-height: 50vh; }
#world-diplomacy { bottom: 1rem; left: 21.5rem; width: 21rem; max-height: 70vh; }
#world-air { top: 1rem; left: 34rem; width: 19rem; max-height: 60vh; }
#world-hud input[type=number] {
  width: 100%; margin-top: .25rem; padding: .25rem;
  background: rgba(255,255,255,.06); color: #eee; font: inherit;
  border: 1px solid rgba(255,255,255,.14); border-radius: 4px;
}
#world-hud .pair { display: flex; gap: .25rem; }
#world-hud .pair > * { flex: 1 1 0; min-width: 0; }
#world-hud .warn { color: #f0a; }
#world-hud .line { margin-bottom: .55rem; padding-bottom: .45rem;
  border-bottom: 1px solid rgba(255,255,255,.08); }
#world-hud .controls { display: flex; gap: .25rem; margin-top: .25rem; }
#world-hud .controls button { margin-top: 0; text-align: center; }
#world-hud select {
  width: 100%; margin-top: .25rem; padding: .25rem;
  background: rgba(255,255,255,.06); color: #eee; font: inherit;
  border: 1px solid rgba(255,255,255,.14); border-radius: 4px;
}
#world-hud button {
  pointer-events: auto; display: block; width: 100%; margin-top: .25rem;
  padding: .3rem .5rem; text-align: left; cursor: pointer;
  background: rgba(255,255,255,.06); color: #eee; font: inherit;
  border: 1px solid rgba(255,255,255,.14); border-radius: 4px;
}
#world-hud button:hover:enabled { background: rgba(255,255,255,.14); }
#world-hud button:disabled { opacity: .38; cursor: default; }
#world-hud .bar {
  height: 4px; margin-top: .25rem; border-radius: 2px;
  background: rgba(255,255,255,.12); overflow: hidden;
}
#world-hud .bar > div { height: 100%; background: #6ea8fe; }
#world-hud .queue-item { margin-bottom: .5rem; }
`;

export interface HudModel {
  /** Null while watching. */
  nation: number | null;
  nations: NationStatic[];
  provinces: Province[];
  controllers: number[];
  owners: number[];
  /** Flat, province * BUILDING_TYPES.length + type. */
  buildings: number[];
  economy: NationEconomyView | null;
  /** Every nation's trust, indexed by nation id. Public to everyone (§7). */
  trust: number[];
  /** Agreements and offers this session may see. Terms only for its own. */
  agreements: AgreementView[];
  selected: number | null;
}

export interface HudActions {
  claim(province: number): void;
  build(province: number, building: BuildingType): void;
  /** By order id, not by position — the queue shifts underneath a position. */
  cancel(orderId: number): void;
  openLine(equipment: EquipmentType): void;
  closeLine(lineId: number): void;
  /**
   * Absolute, never a delta — a delta applied twice means something different
   * from a delta applied once and the player cannot see which happened.
   */
  assignFactories(lineId: number, factories: number): void;
  /** The expensive one. The button that calls this says what it costs. */
  switchLine(lineId: number, equipment: EquipmentType): void;
  raiseDivision(province: number): void;
  startResearch(slot: number, tech: TechId): void;
  cancelResearch(slot: number): void;
  /** Call off a standing attack. The order costs equipment until it stops. */
  cancelAttack(province: number): void;
  /** Terms for a trade, null for everything else. Rates are per tick. */
  propose(to: number, type: AgreementType, terms: TradeTermsView | null): void;
  acceptAgreement(agreementId: number): void;
  declineAgreement(agreementId: number): void;
  /** The expensive one. The button that calls this says what it costs. */
  cancelAgreement(agreementId: number): void;
  setMarketOrder(resource: Resource, perTick: number): void;
  /** Raise a wing at a province holding the base its template needs (§6.7). */
  raiseFormation(province: number, template: FormationTemplate): void;
  /** Send it to a zone with a mission, or bring it home with both null. */
  assignFormation(
    formationId: number,
    zone: number | null,
    mission: Mission | null,
  ): void;
  disbandFormation(formationId: number): void;
}

const TERRAIN_KEY: Partial<Record<TerrainType, StringKey>> = {
  [TerrainType.Plains]: "terrain.plains",
  [TerrainType.Highland]: "terrain.highland",
  [TerrainType.Mountain]: "terrain.mountain",
};

export class Hud {
  private readonly root: HTMLElement;
  private readonly economyPanel: HTMLElement;
  private readonly queuePanel: HTMLElement;
  private readonly provincePanel: HTMLElement;
  private readonly productionPanel: HTMLElement;
  private readonly researchPanel: HTMLElement;
  private readonly diplomacyPanel: HTMLElement;
  private readonly airPanel: HTMLElement;
  /**
   * The diplomacy panel is the only one with a form in it, and a form cannot
   * be rebuilt once a tick.
   *
   * Every other panel is a pure function of the model and is thrown away and
   * redrawn every update, which is what makes "the client derives no state"
   * checkable. A half-typed trade rate is not derived state, though — it is
   * the player mid-sentence — and rebuilding the inputs under them would clear
   * the field and take the focus with it every five seconds. So the lists are
   * redrawn and the form is built once, kept, and moved into place.
   */
  private diplomacyList: HTMLElement | null = null;
  private diplomacyForm: HTMLElement | null = null;
  private diplomacyWho: HTMLSelectElement | null = null;
  /** The air panel's assignment form, kept for the same reason. */
  private airList: HTMLElement | null = null;
  private airForm: HTMLElement | null = null;
  private airWhich: HTMLSelectElement | null = null;
  private airZone: HTMLSelectElement | null = null;

  constructor(private readonly actions: HudActions) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement("div");
    this.root.id = "world-hud";
    this.economyPanel = this.panel("world-economy");
    this.queuePanel = this.panel("world-queue");
    this.provincePanel = this.panel("world-province");
    this.productionPanel = this.panel("world-production");
    this.researchPanel = this.panel("world-research");
    this.diplomacyPanel = this.panel("world-diplomacy");
    this.airPanel = this.panel("world-air");
    document.body.appendChild(this.root);
  }

  private panel(id: string): HTMLElement {
    const element = document.createElement("section");
    element.id = id;
    element.className = "panel";
    element.hidden = true;
    this.root.appendChild(element);
    return element;
  }

  update(model: HudModel): void {
    this.renderEconomy(model);
    this.renderQueue(model);
    this.renderProvince(model);
    this.renderProduction(model);
    this.renderResearch(model);
    this.renderDiplomacy(model);
    this.renderAir(model);
  }

  // -------------------------------------------------------------------------

  private renderEconomy(model: HudModel): void {
    const economy = model.economy;
    this.economyPanel.hidden = economy === null;
    if (economy === null) return;

    // **What the queue actually gets**, not what the factories made. Since
    // phase 7 the construction system spends `made - paid + earned`, and a
    // panel showing the gross figure was quietly promising a build speed the
    // world was not delivering — and the queue's own "days left" was computed
    // from it, so an import that halved the rate left the estimate twice as
    // optimistic with nothing on screen to explain it.
    const netConstruction = constructionNet(economy);
    const traded = economy.tradePointsIn - economy.tradePointsOut;

    this.economyPanel.replaceChildren(
      heading(t("economy.title")),
      row(t("economy.construction"), perDay(netConstruction)),
      ...(Math.abs(traded) > 1e-9
        ? [row(t("economy.tradeShare"), perDay(traded))]
        : []),
      row(t("economy.industry"), perDay(economy.industryPerTick)),
      row(t("economy.supplyRatio"), share(economy.sufficiency)),
      spacer(),
      ...(["steel", "oil", "aluminium", "rubber"] as const).map((resource) =>
        row(
          t(`economy.${resource}` as StringKey),
          // The stock, and what it is moving by. Invariant 1 again: a player
          // who watches any number should see it move, and a number that only
          // shows the total hides the rate that explains it. Trade is part of
          // that movement and used to be missing from it.
          `${amount(economy.resources[resource])}  ` +
            `${perDay(
              economy.extractionPerTick[resource] -
                economy.demandPerTick[resource] * economy.sufficiency +
                economy.tradeResourcePerTick[resource],
            )}`,
        ),
      ),
    );
  }

  private renderQueue(model: HudModel): void {
    const economy = model.economy;
    this.queuePanel.hidden = economy === null;
    if (economy === null) return;

    const children: Node[] = [heading(t("queue.title"))];
    if (economy.queue.length === 0) {
      children.push(muted(t("queue.empty")));
    }

    economy.queue.forEach((order, index) => {
      const spec = BUILDINGS[order.building];
      const item = document.createElement("div");
      item.className = "queue-item";
      item.append(
        row(
          t(`building.${order.building}` as StringKey),
          t("province.title", { id: order.provinceId }),
        ),
      );

      // Only the front item is being worked on, so only it has a finish date.
      const days =
        index === 0
          ? daysRemaining(spec.cost - order.progress, constructionNet(economy))
          : Infinity;
      item.append(
        muted(
          Number.isFinite(days)
            ? t("queue.remaining", { days })
            : `${Math.round(order.progress)} / ${spec.cost}`,
        ),
      );

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      fill.style.width = `${Math.min(100, (order.progress / spec.cost) * 100)}%`;
      bar.appendChild(fill);
      item.append(bar);

      const cancel = document.createElement("button");
      cancel.textContent = t("queue.cancel");
      cancel.addEventListener("click", () => this.actions.cancel(order.id));
      item.append(cancel);
      children.push(item);
    });

    this.queuePanel.replaceChildren(...children);
  }

  private renderProvince(model: HudModel): void {
    const id = model.selected;
    this.provincePanel.hidden = id === null;
    if (id === null) return;

    const province = model.provinces[id];
    const controller = model.controllers[id];
    const owner = model.owners[id];
    const stride = BUILDING_TYPES.length;
    const used = BUILDING_TYPES.reduce(
      (sum, type) =>
        BUILDINGS[type].takesSlot
          ? sum + model.buildings[id * stride + buildingIndex(type)]
          : sum,
      0,
    );
    const builtInfrastructure =
      model.buildings[id * stride + buildingIndex("infrastructure")];

    const children: Node[] = [
      heading(t("province.title", { id })),
      row(t("province.controller"), nationName(model, controller)),
      row(
        t("province.owner"),
        owner === controller
          ? nationName(model, owner)
          : `${nationName(model, owner)} (${t("province.occupied")})`,
      ),
      row(
        t("province.terrain"),
        TERRAIN_KEY[province.terrain] === undefined
          ? "—"
          : t(TERRAIN_KEY[province.terrain] as StringKey),
      ),
      row(
        t("province.infrastructure"),
        fraction(
          Math.min(10, province.infrastructure + builtInfrastructure),
          10,
        ),
      ),
      row(t("province.slots"), fraction(used, province.buildingSlots)),
      row(t("province.deposits"), depositLine(province) ?? t("province.none")),
    ];

    if (province.capital || province.coastal) {
      children.push(
        muted(
          [
            province.capital ? t("province.capital") : null,
            province.coastal ? t("province.coastal") : null,
          ]
            .filter((tag) => tag !== null)
            .join(" · "),
        ),
      );
    }

    // The buildings that are actually there, so the panel is not just a menu.
    const present = BUILDING_TYPES.filter(
      (type) => model.buildings[id * stride + buildingIndex(type)] > 0,
    );
    if (present.length > 0) {
      children.push(spacer(), heading(t("province.buildings")));
      for (const type of present) {
        children.push(
          row(
            t(`building.${type}` as StringKey),
            String(model.buildings[id * stride + buildingIndex(type)]),
          ),
        );
      }
    }

    if (model.nation !== null && controller !== model.nation) {
      // **An order, not an outcome** (§6.9, decision 0014). The button starts
      // a front that grinds every tick and costs equipment for as long as it
      // stands, so the panel says which of the two it is doing and offers the
      // way back out.
      const attacking = model.economy?.attacks.includes(id) === true;
      const button = document.createElement("button");
      button.textContent = attacking
        ? t("province.callOff")
        : t("province.attack");
      button.addEventListener("click", () =>
        attacking ? this.actions.cancelAttack(id) : this.actions.claim(id),
      );
      children.push(spacer(), button);
      if (attacking) children.push(muted(t("province.attacking")));
    }

    // The build menu is only shown where a building could actually go: a menu
    // of things that will be refused is a menu that teaches nothing.
    if (
      model.nation !== null &&
      controller === model.nation &&
      owner === model.nation
    ) {
      const raise = document.createElement("button");
      raise.textContent = t("production.raise", { cost: DIVISION_MANPOWER });
      raise.disabled =
        model.economy === null || model.economy.manpower < DIVISION_MANPOWER;
      raise.addEventListener("click", () => this.actions.raiseDivision(id));
      children.push(spacer(), raise);

      // A wing needs the base its template flies out of, so the button only
      // appears where one stands. The same rule the server applies, shown
      // rather than discovered by being refused.
      for (const template of FORMATION_TEMPLATES) {
        const spec = FORMATIONS[template];
        const built =
          model.buildings[
            id * BUILDING_TYPES.length + buildingIndex(spec.base)
          ];
        if (built === undefined || built === 0) continue;
        const button = document.createElement("button");
        button.textContent = t("air.raise", {
          what: t(`formation.${template}` as StringKey),
          cost: WING_MANPOWER,
        });
        button.disabled =
          model.economy === null || model.economy.manpower < WING_MANPOWER;
        button.addEventListener("click", () =>
          this.actions.raiseFormation(id, template),
        );
        children.push(button);
      }

      children.push(spacer(), heading(t("province.build")));
      for (const type of BUILDING_TYPES) {
        const spec = BUILDINGS[type];
        const button = document.createElement("button");
        button.textContent = `${t(`building.${type}` as StringKey)} — ${spec.cost}`;
        // The same rules the server applies, for display only. The server
        // computes them again and its answer is the one that counts (§7).
        button.disabled =
          (spec.takesSlot && used >= province.buildingSlots) ||
          (spec.coastalOnly && !province.coastal);
        button.addEventListener("click", () => this.actions.build(id, type));
        children.push(button);
      }
    }

    this.provincePanel.replaceChildren(...children);
  }

  /**
   * Production lines, the stockpile, and the divisions drawing on it.
   *
   * The screen where §6.2's lesson has to be legible: a line's efficiency is
   * the number a switch throws away, so the switch control says what it would
   * cost *in that button's own label* rather than warning afterwards. It is
   * the one thing in this game a player can do to themselves by accident that
   * takes an in-game month to undo.
   *
   * Per invariant 9 nothing here is per tick: efficiency is a percentage,
   * output is per in-game day, and the factory counts are filled fractions.
   */
  private renderProduction(model: HudModel): void {
    const economy = model.economy;
    this.productionPanel.hidden = economy === null;
    if (economy === null) return;

    const children: Node[] = [
      heading(t("production.title")),
      row(
        t("production.factories"),
        fraction(
          economy.militaryFactoriesAssigned,
          economy.militaryFactoriesTotal,
        ),
      ),
      row(
        t("production.dockyards"),
        fraction(economy.dockyardsAssigned, economy.dockyardsTotal),
      ),
      row(
        t("production.manpower"),
        `${amount(economy.manpower)} / ${amount(economy.manpowerCap)}`,
      ),
      spacer(),
      heading(t("production.lines")),
    ];

    if (economy.productionLines.length === 0) {
      children.push(muted(t("production.noLines")));
    }

    for (const line of economy.productionLines) {
      const spec = EQUIPMENT[line.equipment];
      const held =
        spec.yard === "dockyard"
          ? economy.dockyardsTotal
          : economy.militaryFactoriesTotal;
      const committed =
        spec.yard === "dockyard"
          ? economy.dockyardsAssigned
          : economy.militaryFactoriesAssigned;

      const item = document.createElement("div");
      item.className = "line";
      item.append(
        row(
          t(`equipment.${line.equipment}` as StringKey),
          fraction(line.factories, held),
        ),
        row(t("production.efficiency"), share(line.efficiency)),
        row(t("production.output"), perDay(line.outputPerTick)),
      );

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      fill.style.width = `${Math.round(line.efficiency * 100)}%`;
      bar.appendChild(fill);
      item.append(bar);

      const controls = document.createElement("div");
      controls.className = "controls";
      const less = document.createElement("button");
      less.textContent = t("production.removeFactory");
      less.disabled = line.factories === 0;
      less.addEventListener("click", () =>
        this.actions.assignFactories(line.id, line.factories - 1),
      );
      const more = document.createElement("button");
      more.textContent = t("production.addFactory");
      // Only what is not already committed to another line can be added. The
      // server checks this again and its answer is the one that counts (§7).
      more.disabled = committed >= held;
      more.addEventListener("click", () =>
        this.actions.assignFactories(line.id, line.factories + 1),
      );
      const close = document.createElement("button");
      close.textContent = t("production.close");
      close.addEventListener("click", () => this.actions.closeLine(line.id));
      controls.append(less, more, close);
      item.append(controls);

      // The switch, with its price on the button. A select alone would let a
      // player throw away a month of ramp with one wrong click and no warning.
      const pick = document.createElement("select");
      for (const type of EQUIPMENT_TYPES) {
        if (type === line.equipment) continue;
        const option = document.createElement("option");
        option.value = type;
        option.textContent = t(`equipment.${type}` as StringKey);
        pick.append(option);
      }
      const swap = document.createElement("button");
      swap.textContent = t("production.switchTo", {
        efficiency: share(line.efficiency),
      });
      swap.addEventListener("click", () =>
        this.actions.switchLine(line.id, pick.value as EquipmentType),
      );
      item.append(pick, swap);
      children.push(item);
    }

    const open = document.createElement("select");
    for (const type of EQUIPMENT_TYPES) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = t(`equipment.${type}` as StringKey);
      open.append(option);
    }
    const openButton = document.createElement("button");
    openButton.textContent = t("production.open");
    openButton.addEventListener("click", () =>
      this.actions.openLine(open.value as EquipmentType),
    );
    children.push(open, openButton);

    children.push(spacer(), heading(t("production.stockpile")));
    const stocked = EQUIPMENT_TYPES.filter(
      (type, index) => (economy.stockpile[index] ?? 0) >= 0.5,
    );
    if (stocked.length === 0) {
      children.push(muted(t("production.stockpileEmpty")));
    }
    for (const type of stocked) {
      children.push(
        row(
          t(`equipment.${type}` as StringKey),
          amount(economy.stockpile[EQUIPMENT_TYPES.indexOf(type)]),
        ),
      );
    }

    if (economy.attacks.length > 0) {
      children.push(spacer(), heading(t("production.fronts")));
      for (const province of economy.attacks) {
        const item = document.createElement("div");
        item.className = "line";
        item.append(row(t("province.title", { id: province }), ""));
        const off = document.createElement("button");
        off.textContent = t("province.callOff");
        off.addEventListener("click", () =>
          this.actions.cancelAttack(province),
        );
        item.append(off);
        children.push(item);
      }
    }

    children.push(spacer(), heading(t("production.divisions")));
    if (economy.divisions.length === 0) {
      children.push(muted(t("production.noDivisions")));
    }
    for (const division of economy.divisions) {
      children.push(
        row(
          t("production.divisionAt", {
            id: division.id,
            province: division.provinceId,
          }),
          // Two numbers, not one. A weak division needs equipment out of the
          // stockpile; an unsupplied one needs a hub or a shorter front. A
          // single figure would say something is wrong and nothing about
          // which of the two it is.
          t("production.divisionState", {
            strength: share(division.strength),
            supply: share(division.supply),
          }),
        ),
      );
    }

    this.productionPanel.replaceChildren(...children);
  }

  /**
   * The research slots, and the flat list of what they could work on.
   *
   * §6.4 keeps this system small on purpose, and the screen keeps the promise:
   * a slot, a bar, a day count, and a list of what is available. A tech whose
   * prerequisites are missing is shown with what it needs rather than hidden —
   * a list that hides half of itself teaches nobody what to research next.
   */
  private renderResearch(model: HudModel): void {
    const economy = model.economy;
    this.researchPanel.hidden = economy === null;
    if (economy === null) return;

    const children: Node[] = [heading(t("research.title"))];
    const known = new Set<TechId>(economy.unlockedTechs);

    economy.researchSlots.forEach((slot, index) => {
      const item = document.createElement("div");
      item.className = "line";
      if (!slot.unlocked) {
        item.append(muted(t("research.locked")));
        children.push(item);
        return;
      }
      if (slot.tech === null) {
        item.append(muted(t("research.idle")));
        children.push(item);
        return;
      }

      const total = TECHS[slot.tech].ticks;
      item.append(
        row(
          t(`tech.${slot.tech}` as StringKey),
          // Invariant 9: what is left, in in-game days. One tick of research
          // is one hour, and a slot does one tick of work per tick.
          t("research.remaining", {
            days: daysRemaining(total - slot.progress, 1),
          }),
        ),
      );
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      fill.style.width = `${Math.min(100, (slot.progress / total) * 100)}%`;
      bar.appendChild(fill);
      item.append(bar);

      const drop = document.createElement("button");
      drop.textContent = t("research.cancel");
      drop.addEventListener("click", () => this.actions.cancelResearch(index));
      item.append(drop);
      children.push(item);
    });

    const free = economy.researchSlots.findIndex(
      (slot) => slot.unlocked && slot.tech === null,
    );
    const busy = new Set(
      economy.researchSlots
        .map((slot) => slot.tech)
        .filter((id) => id !== null),
    );
    const offered = TECH_IDS.filter((id) => !known.has(id) && !busy.has(id));
    for (const id of offered) {
      const ready = isAvailable(id, economy.unlockedTechs);
      const button = document.createElement("button");
      const days = Math.ceil(TECHS[id].ticks / 24);
      button.textContent = `${t(`tech.${id}` as StringKey)} — ${days}d`;
      button.disabled = !ready || free < 0;
      if (!ready) {
        button.title = t("research.needs", {
          techs: TECHS[id].requires
            .filter((need) => !known.has(need))
            .map((need) => t(`tech.${need}` as StringKey))
            .join(", "),
        });
      }
      button.addEventListener("click", () => {
        if (free >= 0) this.actions.startResearch(free, id);
      });
      children.push(button);
    }

    children.push(spacer(), heading(t("research.known")));
    if (economy.unlockedTechs.length === 0) {
      children.push(muted(t("research.none")));
    }
    for (const id of economy.unlockedTechs) {
      children.push(muted(t(`tech.${id}` as StringKey)));
    }

    this.researchPanel.replaceChildren(...children);
  }

  /**
   * Diplomacy: what has been offered, what stands, and what the market wants.
   *
   * Everything here is per in-game day (invariant 9) and the wire is per tick,
   * so every rate is multiplied on the way out and divided on the way in. The
   * two prices a player has to see before deciding are both on their buttons:
   * what a cancellation costs in trust, and what the market charges for a
   * resource nobody will sell them.
   */
  private renderDiplomacy(model: HudModel): void {
    const nation = model.nation;
    this.diplomacyPanel.hidden = nation === null || model.economy === null;
    if (nation === null || model.economy === null) return;

    const mine = model.agreements.filter((a) => a.parties.includes(nation));
    const offersToMe = mine.filter(
      (a) => !a.accepted && a.parties[1] === nation,
    );
    const offersFromMe = mine.filter(
      (a) => !a.accepted && a.parties[0] === nation,
    );
    const standing = mine.filter((a) => a.accepted);

    const children: Node[] = [
      heading(t("diplomacy.title")),
      row(t("diplomacy.trust"), amount(model.trust[nation] ?? 0)),
      row(
        t("diplomacy.tradeBalance"),
        `${perDay(model.economy.tradePointsIn)} / ${perDay(model.economy.tradePointsOut)}`,
      ),
    ];

    // Offers waiting on this player first: it is the only thing on this panel
    // that somebody else is waiting for an answer to.
    children.push(spacer(), heading(t("diplomacy.offers")));
    if (offersToMe.length === 0) children.push(muted(t("diplomacy.noOffers")));
    for (const offer of offersToMe) {
      const item = document.createElement("div");
      item.className = "line";
      item.append(
        row(
          t(`agreement.${offer.type}` as StringKey),
          nationName(model, offer.parties[0]),
        ),
      );
      if (offer.terms !== null) item.append(muted(termsLine(offer.terms)));
      const controls = document.createElement("div");
      controls.className = "controls";
      const accept = document.createElement("button");
      accept.textContent = t("diplomacy.accept");
      accept.addEventListener("click", () =>
        this.actions.acceptAgreement(offer.id),
      );
      const decline = document.createElement("button");
      decline.textContent = t("diplomacy.decline");
      decline.addEventListener("click", () =>
        this.actions.declineAgreement(offer.id),
      );
      controls.append(accept, decline);
      item.append(controls);
      children.push(item);
    }

    for (const offer of offersFromMe) {
      const item = document.createElement("div");
      item.className = "line";
      item.append(
        row(
          t("diplomacy.offered", {
            type: t(`agreement.${offer.type}` as StringKey),
          }),
          nationName(model, offer.parties[1]),
        ),
      );
      if (offer.terms !== null) item.append(muted(termsLine(offer.terms)));
      const withdraw = document.createElement("button");
      withdraw.textContent = t("diplomacy.withdraw");
      withdraw.addEventListener("click", () =>
        this.actions.declineAgreement(offer.id),
      );
      item.append(withdraw);
      children.push(item);
    }

    children.push(spacer(), heading(t("diplomacy.standing")));
    if (standing.length === 0)
      children.push(muted(t("diplomacy.noneStanding")));
    for (const agreement of standing) {
      const other =
        agreement.parties[0] === nation
          ? agreement.parties[1]
          : agreement.parties[0];
      const item = document.createElement("div");
      item.className = "line";
      item.append(
        row(
          t(`agreement.${agreement.type}` as StringKey),
          nationName(model, other),
        ),
      );
      if (agreement.terms !== null) {
        item.append(
          muted(
            agreement.parties[0] === nation
              ? t("diplomacy.youSend", {
                  terms: termsLine(agreement.terms),
                })
              : t("diplomacy.youReceive", {
                  terms: termsLine(agreement.terms),
                }),
          ),
        );
      }

      if (agreement.noticeAt === null) {
        // **The price is on the button** — the same reasoning as the
        // production line's switch. An indefinite commitment whose exit cost
        // is hidden until after the click is not a commitment a player made.
        const cancel = document.createElement("button");
        cancel.textContent = t("diplomacy.cancel", {
          trust: String(TRUST_COST[agreement.type]),
        });
        cancel.addEventListener("click", () =>
          this.actions.cancelAgreement(agreement.id),
        );
        item.append(cancel);
      } else {
        const notice = document.createElement("div");
        notice.className = "warn";
        notice.textContent =
          agreement.noticeBy === nation
            ? t("diplomacy.noticeGiven")
            : t("diplomacy.noticeReceived", {
                nation: nationName(model, agreement.noticeBy ?? 0),
              });
        item.append(notice);
      }
      children.push(item);
    }

    // **Everything standing, not only the market.** `tradeResourcePerTick` is
    // the net of every agreement *and* every market order, so filing it under
    // "world market" named the wrong counterparty — a player reading it would
    // have gone looking for a standing order that was really a treaty.
    const moving = RESOURCES.filter(
      (resource) =>
        Math.abs(model.economy?.tradeResourcePerTick[resource] ?? 0) > 1e-9,
    );
    if (moving.length > 0) {
      children.push(spacer(), heading(t("diplomacy.flows")));
      for (const resource of moving) {
        children.push(
          row(
            t(`economy.${resource}` as StringKey),
            perDay(model.economy.tradeResourcePerTick[resource]),
          ),
        );
      }
    }

    // The lists are redrawn; the form below them is not. See the field
    // declarations for why.
    if (this.diplomacyList === null) {
      this.diplomacyList = document.createElement("div");
      this.diplomacyPanel.append(this.diplomacyList);
    }
    this.diplomacyList.replaceChildren(...children);
    this.buildDiplomacyForm(model);
    this.refreshNationOptions(model);
  }

  /**
   * Keep the trust figures in the nation picker current.
   *
   * In place, on the options that are already there. Rebuilding the select
   * would be simpler and would throw away whatever the player had chosen, on
   * every tick — which is the same failure the form itself is built once to
   * avoid.
   */
  private refreshNationOptions(model: HudModel): void {
    const who = this.diplomacyWho;
    if (who === null) return;
    for (const option of Array.from(who.options)) {
      const id = Number(option.value);
      const name =
        model.nations.find((n) => n.smallID === id)?.name ?? `#${id}`;
      const label = `${name} — ${t("diplomacy.trustShort", {
        trust: amount(model.trust[id] ?? 0),
      })}`;
      if (option.textContent !== label) option.textContent = label;
    }
  }

  /**
   * The half of the diplomacy panel a player types into, built exactly once.
   *
   * Lazily, because it needs the nation list, which arrives with the first
   * full state — and once, because a player entering a rate is mid-sentence
   * and an update every five seconds would take the field out from under them.
   */
  /**
   * The air panel: what is in the sky, and where it is.
   *
   * Two lists and a form, and the split between them is the same one the
   * diplomacy panel makes. The lists are a pure function of the model and are
   * redrawn every update; the form is built once and kept, because a player
   * halfway through choosing a zone is mid-sentence.
   *
   * Zones are named by number rather than by geography, which is honest — the
   * partition comes out of the generator and has no names to give (§6.7).
   */
  private renderAir(model: HudModel): void {
    const economy = model.economy;
    this.airPanel.hidden = economy === null;
    if (economy === null) return;

    if (this.airList === null) {
      this.airList = document.createElement("div");
      this.airPanel.append(this.airList);
    }

    const children: Node[] = [heading(t("air.title"))];

    if (economy.zones.length === 0) {
      children.push(muted(t("air.noZones")));
    }
    for (const zone of economy.zones) {
      // Only zones somebody is contesting are worth a line: a player holding
      // twelve quiet zones does not need twelve rows saying so.
      if (!zone.contested && zone.ownStrength === 0) continue;
      children.push(
        row(
          t("air.zone", { zone: zone.zone }),
          zone.contested
            ? t("air.superiority", { value: share(zone.superiority) })
            : t("air.uncontested"),
        ),
      );
    }

    children.push(spacer(), heading(t("air.formations")));
    if (economy.formations.length === 0) {
      children.push(muted(t("air.noFormations")));
    }
    for (const formation of economy.formations) {
      const line = document.createElement("div");
      line.className = "line";
      line.append(
        row(
          t(`formation.${formation.template}` as StringKey),
          share(formation.strength),
        ),
      );
      line.append(
        muted(
          formation.zone === null || formation.mission === null
            ? t("air.onTheGround", { province: formation.baseProvinceId })
            : t("air.flying", {
                zone: formation.zone,
                mission: t(`mission.${formation.mission}` as StringKey),
              }),
        ),
      );
      if (formation.zone !== null) {
        const home = document.createElement("button");
        home.textContent = t("air.bringHome");
        home.addEventListener("click", () =>
          this.actions.assignFormation(formation.id, null, null),
        );
        line.append(home);
      }
      children.push(line);
    }

    this.airList.replaceChildren(...children);
    this.buildAirForm(model);
    this.refreshAirOptions(model);
  }

  /**
   * The formation and zone options, kept current in place.
   *
   * In place rather than rebuilt, for the reason `refreshNationOptions` gives:
   * a rebuilt select throws away whatever the player had chosen, every tick.
   * Options are added and removed as wings are raised and lost, and the
   * selection survives unless the thing it named is gone.
   */
  private refreshAirOptions(model: HudModel): void {
    const which = this.airWhich;
    const zone = this.airZone;
    const economy = model.economy;
    if (which === null || zone === null || economy === null) return;

    const chosen = which.value;
    const wanted = economy.formations.map((formation) => ({
      value: String(formation.id),
      label: `${t(`formation.${formation.template}` as StringKey)} #${formation.id}`,
    }));
    syncOptions(which, wanted);
    if (wanted.some((option) => option.value === chosen)) which.value = chosen;

    // Every zone the nation can see. Out-of-reach ones are left in and
    // refused by the server, which is the one whose answer counts (§7) — and
    // a zone that vanished from the list mid-click would be worse.
    const zoneChosen = zone.value;
    const zones = economy.zones.map((view) => ({
      value: String(view.zone),
      label: t("air.zone", { zone: view.zone }),
    }));
    syncOptions(zone, zones);
    if (zones.some((option) => option.value === zoneChosen)) {
      zone.value = zoneChosen;
    }
  }

  /** The assignment form, built exactly once. */
  private buildAirForm(model: HudModel): void {
    if (this.airForm !== null) return;
    if (model.economy === null) return;

    const form = document.createElement("div");
    const which = document.createElement("select");
    const zone = document.createElement("select");
    const mission = document.createElement("select");
    for (const id of AIR_MISSIONS) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = t(`mission.${id}` as StringKey);
      mission.append(option);
    }

    const send = document.createElement("button");
    send.textContent = t("air.send");
    send.addEventListener("click", () => {
      if (which.value === "" || zone.value === "") return;
      this.actions.assignFormation(
        Number(which.value),
        Number(zone.value),
        mission.value as Mission,
      );
    });

    form.append(spacer(), heading(t("air.assign")), which, zone, mission, send);
    this.airForm = form;
    this.airWhich = which;
    this.airZone = zone;
    this.airPanel.append(form);
  }

  private buildDiplomacyForm(model: HudModel): void {
    if (this.diplomacyForm !== null) return;
    if (model.nation === null || model.nations.length === 0) return;
    const nation = model.nation;

    const form = document.createElement("div");
    // Proposing. Nation, type, and — for a trade — what each side sends.
    const who = document.createElement("select");
    for (const other of model.nations) {
      if (other.smallID === nation) continue;
      const option = document.createElement("option");
      option.value = String(other.smallID);
      option.textContent = `${other.name} — ${t("diplomacy.trustShort", {
        trust: amount(model.trust[other.smallID] ?? 0),
      })}`;
      who.append(option);
    }
    const what = document.createElement("select");
    for (const type of AGREEMENT_TYPES) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = t(`agreement.${type}` as StringKey);
      what.append(option);
    }
    const give = document.createElement("select");
    for (const resource of RESOURCES) {
      const option = document.createElement("option");
      option.value = resource;
      option.textContent = t(`economy.${resource}` as StringKey);
      give.append(option);
    }
    // Per day, and starting at a trade somebody might actually offer rather
    // than at zero: half a unit and a quarter of a construction point per
    // tick, which is what the phase-7 gate trades.
    const rate = numberInput(
      TICKS_PER_DAY * 0.25,
      MAX_TRADE_RESOURCE_PER_TICK * TICKS_PER_DAY,
      TICKS_PER_DAY * 0.5,
    );
    const price = numberInput(
      TICKS_PER_DAY * 0.25,
      MAX_TRADE_POINTS_PER_TICK * TICKS_PER_DAY,
      TICKS_PER_DAY * 0.25,
    );
    const terms = document.createElement("div");
    terms.append(give, pair(rate, price));
    const offer = document.createElement("button");
    const syncTerms = (): void => {
      terms.hidden = what.value !== "trade";
    };
    what.addEventListener("change", syncTerms);
    syncTerms();
    offer.textContent = t("diplomacy.send");
    offer.addEventListener("click", () => {
      const type = what.value as AgreementType;
      this.actions.propose(
        Number(who.value),
        type,
        type === "trade"
          ? {
              resource: give.value as Resource,
              // Per day on the screen, per tick on the wire, and clamped on
              // the way out. The server checks the same limits and its answer
              // is the one that counts (§7) — this is about never handing it
              // something it has to refuse.
              resourcePerTick: clamped(rate) / TICKS_PER_DAY,
              pointsPerTick: clamped(price) / TICKS_PER_DAY,
            }
          : null,
      );
    });
    form.append(
      spacer(),
      heading(t("diplomacy.propose")),
      who,
      what,
      terms,
      offer,
    );

    // The market. Always there, always a bad deal, and never an obligation.
    // Its rates are constants, so they belong here with the controls; what a
    // nation is actually moving changes every tick and is drawn with the
    // lists above.
    form.append(spacer(), heading(t("diplomacy.market")));
    for (const resource of RESOURCES) {
      form.append(
        row(
          t(`economy.${resource}` as StringKey),
          t("diplomacy.marketRates", {
            buy: String(MARKET_BUY_POINTS[resource]),
            sell: String(MARKET_SELL_POINTS[resource]),
          }),
        ),
      );
    }
    const marketResource = document.createElement("select");
    for (const resource of RESOURCES) {
      const option = document.createElement("option");
      option.value = resource;
      option.textContent = t(`economy.${resource}` as StringKey);
      marketResource.append(option);
    }
    const marketRate = numberInput(
      -MAX_MARKET_PER_TICK * TICKS_PER_DAY,
      MAX_MARKET_PER_TICK * TICKS_PER_DAY,
      0,
    );
    const marketButton = document.createElement("button");
    marketButton.textContent = t("diplomacy.setOrder");
    marketButton.addEventListener("click", () =>
      this.actions.setMarketOrder(
        marketResource.value as Resource,
        clamped(marketRate) / TICKS_PER_DAY,
      ),
    );
    form.append(marketResource, marketRate, marketButton);

    this.diplomacyWho = who;
    this.diplomacyForm = form;
    this.diplomacyPanel.append(form);
  }
}

/** One trade's terms in a line, per day like everything else on screen. */
function termsLine(terms: TradeTermsView): string {
  return t("diplomacy.terms", {
    resource: t(`economy.${terms.resource}` as StringKey),
    rate: perDay(terms.resourcePerTick),
    points: perDay(terms.pointsPerTick),
  });
}

/**
 * A number field that starts at something sendable.
 *
 * **`min` and `max` on an input are advisory** outside a form submit — nothing
 * enforces them, and `Number("")` is 0. A field that starts at 0 and a server
 * that treats an impossible rate as a protocol violation together threw the
 * player out of the world for pressing Send without typing. The server answers
 * such a rate with a refusal now, and this end does not produce one: it starts
 * inside the range and `clamped` puts whatever was typed back into it.
 */
function numberInput(
  min: number,
  max: number,
  start: number,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "0.5";
  input.value = String(start);
  return input;
}

/** What the field says, forced back between its own min and max. */
function clamped(input: HTMLInputElement): number {
  const typed = Number(input.value);
  const min = Number(input.min);
  const max = Number(input.max);
  if (!Number.isFinite(typed)) return min;
  return Math.min(max, Math.max(min, typed));
}

function pair(a: HTMLElement, b: HTMLElement): HTMLElement {
  const element = document.createElement("div");
  element.className = "pair";
  element.append(a, b);
  return element;
}

/**
 * Construction points the queue will actually be given this tick.
 *
 * The same arithmetic the server's `constructionAvailable` does: what the
 * civilian factories made, less what trade and the market are taking, plus
 * what exports earned. Duplicated here rather than sent, because the two
 * halves it is made of are already on the wire and a third figure would be a
 * third thing that can disagree.
 */
function constructionNet(economy: NationEconomyView): number {
  return Math.max(
    0,
    economy.constructionPerTick -
      economy.tradePointsOut +
      economy.tradePointsIn,
  );
}

function nationName(model: HudModel, nation: number): string {
  if (nation === 0) return t("province.unowned");
  return model.nations.find((n) => n.smallID === nation)?.name ?? `#${nation}`;
}

function depositLine(province: Province): string | null {
  const parts = Object.entries(province.resourceDeposits)
    .filter(([, size]) => (size ?? 0) > 0)
    .map(
      ([resource, size]) =>
        `${t(`economy.${resource}` as StringKey)} ${String(size)}`,
    );
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * Bring a select's options in line with a list, without rebuilding it.
 *
 * Options are matched by value and only what differs is touched, so a player
 * who has chosen one keeps it across an update that did not remove it. The
 * caller restores the selection, because only the caller knows whether the
 * thing it named is still there.
 */
function syncOptions(
  select: HTMLSelectElement,
  wanted: { value: string; label: string }[],
): void {
  const have = new Map<string, HTMLOptionElement>();
  for (const option of Array.from(select.options))
    have.set(option.value, option);

  for (const [value, option] of have) {
    if (!wanted.some((entry) => entry.value === value)) option.remove();
  }
  for (const entry of wanted) {
    const existing = have.get(entry.value);
    if (existing === undefined) {
      const option = document.createElement("option");
      option.value = entry.value;
      option.textContent = entry.label;
      select.append(option);
    } else if (existing.textContent !== entry.label) {
      existing.textContent = entry.label;
    }
  }
}

function heading(text: string): HTMLElement {
  const element = document.createElement("h2");
  element.textContent = text;
  return element;
}

function row(label: string, value: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "row";
  const left = document.createElement("span");
  left.className = "muted";
  left.textContent = label;
  const right = document.createElement("span");
  right.textContent = value;
  element.append(left, right);
  return element;
}

function muted(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "muted";
  element.textContent = text;
  return element;
}

function spacer(): HTMLElement {
  const element = document.createElement("div");
  element.style.height = ".5rem";
  return element;
}
