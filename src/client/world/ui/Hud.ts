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

import {
  BUILDING_TYPES,
  buildingIndex,
  BUILDINGS,
  type BuildingType,
} from "src/shared/economy/Buildings";
import type { Province } from "src/shared/map/Province";
import { TerrainType } from "src/shared/map/Terrain";
import type { NationEconomyView, NationStatic } from "src/shared/protocol/Wire";
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
  selected: number | null;
}

export interface HudActions {
  claim(province: number): void;
  build(province: number, building: BuildingType): void;
  cancel(index: number): void;
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

  constructor(private readonly actions: HudActions) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement("div");
    this.root.id = "world-hud";
    this.economyPanel = this.panel("world-economy");
    this.queuePanel = this.panel("world-queue");
    this.provincePanel = this.panel("world-province");
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
  }

  // -------------------------------------------------------------------------

  private renderEconomy(model: HudModel): void {
    const economy = model.economy;
    this.economyPanel.hidden = economy === null;
    if (economy === null) return;

    this.economyPanel.replaceChildren(
      heading(t("economy.title")),
      row(t("economy.construction"), perDay(economy.constructionPerTick)),
      row(t("economy.industry"), perDay(economy.industryPerTick)),
      row(t("economy.supplyRatio"), share(economy.sufficiency)),
      spacer(),
      ...(["steel", "oil", "aluminium", "rubber"] as const).map((resource) =>
        row(
          t(`economy.${resource}` as StringKey),
          // The stock, and what it is moving by. Invariant 1 again: a player
          // who watches any number should see it move, and a number that only
          // shows the total hides the rate that explains it.
          `${amount(economy.resources[resource])}  ` +
            `${perDay(economy.extractionPerTick[resource] - economy.demandPerTick[resource] * economy.sufficiency)}`,
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
          ? daysRemaining(
              spec.cost - order.progress,
              economy.constructionPerTick,
            )
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
      cancel.addEventListener("click", () => this.actions.cancel(index));
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
      const claim = document.createElement("button");
      claim.textContent = t("province.claim");
      claim.addEventListener("click", () => this.actions.claim(id));
      children.push(spacer(), claim);
    }

    // The build menu is only shown where a building could actually go: a menu
    // of things that will be refused is a menu that teaches nothing.
    if (
      model.nation !== null &&
      controller === model.nation &&
      owner === model.nation
    ) {
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
