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
import { REGENT_FOCI, type RegentFocus } from "src/shared/config/regent";
import {
  isAvailable,
  TECH_IDS,
  TECHS,
  type TechEffect,
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
  MISSIONS_BY_KIND,
  type FormationTemplate,
  type Mission,
} from "src/shared/economy/Formations";
import type { Province } from "src/shared/map/Province";
import { TerrainType } from "src/shared/map/Terrain";
import { zoneInReach } from "src/shared/map/Zones";
import type {
  AgreementView,
  BattleView,
  FrontView,
  InvasionView,
  NationEconomyView,
  NationStatic,
  TradeTermsView,
  VictoryView,
} from "src/shared/protocol/Wire";
import { nationCss } from "../Palette";
import {
  amount,
  daysRemaining,
  fraction,
  percent,
  perDay,
  share,
} from "./Format";
import { t, type HelpKey, type StringKey } from "./strings";

const STYLE = `
#world-hud, #world-hud * { box-sizing: border-box; }
#world-hud {
  position: fixed; inset: 0; pointer-events: none;
  /* Above the map, and this line is load-bearing. The canvas is inserted into
     the body after the HUD and is also position:fixed inset:0, so with both at
     z-index auto the later element wins and the map is painted straight over
     every panel: a HUD fully built, fully populated and completely invisible.
     elementFromPoint over the economy panel returned the canvas.
     pointer-events above is what keeps this honest — the HUD covers the whole
     viewport and must not swallow the drags that pan the map, so only .panel
     takes them back. */
  z-index: 10;
  font: 15px/1.5 system-ui, sans-serif; color: #e8ecf3;
}
#world-hud .panel {
  position: absolute; pointer-events: auto;
  background: rgba(20,23,30,.92); border: 1px solid rgba(255,255,255,.12);
  border-radius: 10px; padding: .85rem 1rem; backdrop-filter: blur(6px);
  box-shadow: 0 12px 32px rgba(0,0,0,.38);
  max-height: calc(100vh - 5.5rem); overflow-y: auto;
}
#world-hud h2 {
  margin: 0 0 .55rem; font-size: 12px; font-weight: 650;
  letter-spacing: .09em; text-transform: uppercase; color: #8d97a8;
}
#world-hud .row { display: flex; justify-content: space-between; gap: 1rem; }
#world-hud .row span:last-child { color: #fff; font-variant-numeric: tabular-nums; }
#world-hud .muted { color: #9aa4b2; }
/* One panel at a time, all anchored under the menu bar. The province panel
   is the exception: it answers a click on the map and lives on the right. */
/* All under the bar, which is 3.25rem tall. */
#world-economy { top: 4.25rem; left: 1rem; width: 17rem; }
#world-queue { top: 4.25rem; left: 1rem; width: 18rem; }
#world-province { top: 4.25rem; right: 1rem; width: 19rem; }
#world-production { top: 4.25rem; left: 1rem; width: 22rem; max-height: 78vh; }
#world-research { top: 4.25rem; left: 1rem; width: 20rem; max-height: 78vh; }
#world-diplomacy { top: 4.25rem; left: 1rem; width: 23rem; max-height: 78vh; }
#world-air { top: 4.25rem; left: 1rem; width: 21rem; max-height: 78vh; }

/* The bar. It spans the window rather than floating as six loose buttons:
   six unanchored glyphs over a map read as decoration, and there was nothing
   on screen telling a new player that the top-left corner was the controls. */
#world-menu {
  position: absolute; top: 0; left: 0; right: 0; height: 3.25rem;
  display: flex; align-items: center; gap: .3rem; padding: 0 .75rem;
  /* A flex row of nowrap children cannot shrink below its text, and the
     overflow of a fixed ancestor is unreachable — no scrollbar, no way to the
     last buttons. At 1024px, or a 1366px laptop at 125%, that put the nation
     badge off the right edge and clipped the last button. Scroll it. */
  overflow-x: auto; scrollbar-width: thin;
  background: linear-gradient(180deg, rgba(16,18,24,.96), rgba(16,18,24,.82));
  border-bottom: 1px solid rgba(255,255,255,.10);
  box-shadow: 0 6px 20px rgba(0,0,0,.35);
  backdrop-filter: blur(8px);
  /* The HUD root is pointer-events:none so the map still pans; the bar, like
     .panel, takes them back.

     It takes the whole strip, not just the buttons, and that is deliberate:
     the bar is opaque, so there is no map to see underneath it, and a solid
     toolbar that lets a drag through to something invisible is stranger than
     one that does not. The cost is real and small — 3.25rem of map at the top,
     and a pan cannot begin there. */
  pointer-events: auto;
}
#world-menu .brand {
  display: flex; align-items: baseline; gap: .5rem;
  margin-right: .9rem; padding-right: .9rem;
  border-right: 1px solid rgba(255,255,255,.10);
  white-space: nowrap;
}
#world-menu .brand b { font-size: 15px; font-weight: 650; letter-spacing: .01em; }
#world-menu .brand span { font-size: 12px; color: #8d97a8; }
#world-menu button {
  display: inline-flex; align-items: center; gap: .45rem;
  width: auto; margin-top: 0; padding: .42rem .7rem;
  text-align: left; font: inherit; font-size: 14px; line-height: 1.2;
  cursor: pointer; white-space: nowrap;
  background: rgba(255,255,255,.05); color: #d8dee8;
  border: 1px solid rgba(255,255,255,.10); border-radius: 8px;
}
#world-menu button .glyph { font-size: 15px; line-height: 1; }
#world-menu button:hover:enabled {
  background: rgba(255,255,255,.13); color: #fff;
  border-color: rgba(255,255,255,.2);
}
#world-menu button[aria-pressed="true"] {
  background: rgba(110,168,254,.26); color: #fff;
  border-color: rgba(110,168,254,.65);
}
/* The clock, then who you are. The clock takes the auto margin so both sit
   on the right; the badge is separated from it by a hairline. */
#world-menu .clock {
  margin-left: auto; font-size: 13px; color: #aab4c4; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
#world-menu .who {
  margin-left: .9rem; padding-left: .9rem;
  border-left: 1px solid rgba(255,255,255,.10);
  display: flex; align-items: center; gap: .5rem;
  font-size: 13px; color: #aab4c4; white-space: nowrap;
  /* Shrinkable, so a long spectator line yields before the buttons do. */
  min-width: 0; overflow: hidden; text-overflow: ellipsis;
}
#world-menu .who .flag { height: .95rem; width: auto; border-radius: 2px; }
#world-menu .who .swatch {
  width: .8rem; height: .8rem; border-radius: 3px;
  border: 1px solid rgba(0,0,0,.5);
}
/* Narrow windows drop the labels rather than the buttons. 78rem, not 60:
   with all six labels the bar needs about 1140px, so a 1024px window was
   overflowing while still being told it was wide enough. */
@media (max-width: 78rem) {
  #world-menu button .label { display: none; }
  #world-menu .brand span { display: none; }
}
#world-hud .spectator { color: #aab4c4; margin: 0 0 .6rem; }
#world-hud input[type=number] {
  width: 100%; margin-top: .25rem; padding: .25rem;
  background: rgba(255,255,255,.06); color: #eee; font: inherit;
  border: 1px solid rgba(255,255,255,.14); border-radius: 4px;
}
#world-hud .pair { display: flex; gap: .25rem; }
#world-hud .pair > * { flex: 1 1 0; min-width: 0; }
#world-hud .warn { color: #f0a; }
/* A front's bar is in the attacker's colour, set inline; the track is the
   same as every other bar. */
#world-hud .bar.front { height: 6px; }
#world-hud .field { display: block; margin-top: .6rem; }
#world-hud .caption {
  display: block; font-size: 13px; font-weight: 600; color: #dbe2ec;
}
#world-hud .hint {
  display: block; margin: .15rem 0 .1rem; font-size: 12px; line-height: 1.4;
  color: #8d97a8;
}
/* The circled i, and the explanation it opens inline. Inline in the panel,
   never a popover: the HUD root is pointer-events:none and the canvas sits
   after it in the body, so anything appended to <body> is unreachable. */
#world-hud button.info {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.05rem; height: 1.05rem; margin: 0 0 0 .35rem; padding: 0;
  vertical-align: text-bottom; border-radius: 50%; font-size: 10px;
  font-weight: 700; font-style: italic; line-height: 1;
  color: #aab4c4; background: transparent; border: 1px solid #6f7a8b;
}
#world-hud button.info:hover:enabled { color: #fff; border-color: #aab4c4; background: transparent; }
#world-hud button.info[aria-expanded="true"] { color: #fff; border-color: #6ea8fe; background: rgba(110,168,254,.26); }
#world-hud .help {
  margin: .2rem 0 .5rem; padding: .45rem .6rem; font-size: 12px; line-height: 1.45;
  color: #c7cfdb; background: rgba(110,168,254,.10);
  border-left: 2px solid rgba(110,168,254,.55); border-radius: 0 4px 4px 0;
}
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
/* Half, not a third: a disabled button now carries the reason it is disabled,
   and a reason nobody can read is no better than none. */
#world-hud button:disabled { opacity: .55; cursor: default; }
/* Under a button's label: why it is disabled (.why), or what it does
   (.effect). Inline in the button, because the HUD root is
   pointer-events:none and a hover title alone is unreachable on touch. */
#world-hud button .why, #world-hud button .effect {
  display: block; font-size: 12px; line-height: 1.35; white-space: normal;
}
#world-hud button .why { color: #e4b660; }
#world-hud button .effect { color: #8fb4e8; }
#world-hud .bar {
  height: 4px; margin-top: .25rem; border-radius: 2px;
  background: rgba(255,255,255,.12); overflow: hidden;
}
#world-hud .bar > div { height: 100%; background: #6ea8fe; }
#world-hud .queue-item { margin-bottom: .5rem; }
`;

/** The panels the menu bar rotates between. */
type PanelId =
  | "economy"
  | "queue"
  | "production"
  | "research"
  | "diplomacy"
  | "air";

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
  /** Where the season stands. Public (§10). */
  victory: VictoryView;
  /** Every standing front, public: the defender must see it too. */
  fronts: FrontView[];
  /** Every crossing under way, public: §6.8's defence is seeing it come. */
  invasions: InvasionView[];
  /** This tick's battles this nation is party to. Empty for a spectator. */
  battles: BattleView[];
  /**
   * The world's tick, for the clock. One tick is one in-game hour (§4), and
   * without a clock every "12/day" on screen is a number with no scale.
   */
  tick: number;
  selected: number | null;
}

export interface HudActions {
  /**
   * Open the nation chooser again.
   *
   * A spectator needs it, and so does anyone whose claim was refused. It is
   * an action rather than something the HUD does itself because choosing
   * restarts the connection, which is the client's business, not a panel's.
   */
  chooseNation(): void;
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
  /** Send a division across the sea at a hostile coast (§6.8). */
  navalInvade(divisionId: number, province: number): void;
  /** Set how the world plays this nation when nobody is (§6.10). */
  configureRegent(
    enabled: boolean,
    focus: RegentFocus,
    marketBudget: number,
  ): void;
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
  private airMission: HTMLSelectElement | null = null;
  /** The economy panel's rebuilt half, so the regent form below survives. */
  private economyList: HTMLElement | null = null;
  /** The regent form, built once — it holds what the player is choosing. */
  private regentForm: HTMLElement | null = null;
  private regentEnabled: HTMLInputElement | null = null;
  private regentFocus: HTMLSelectElement | null = null;
  private regentBudget: HTMLInputElement | null = null;

  /**
   * Which of the menu's panels is open. One at a time: six always-open panels
   * covered half the map, and the first thing anyone should see is the map.
   * The province panel is not in this rotation — it answers a click on the
   * map and comes and goes with the selection.
   */
  private open: PanelId | null = "economy";
  /** The last model seen, so a menu click can redraw without waiting a tick. */
  private lastModel: HudModel | null = null;
  private readonly menuButtons = new Map<PanelId, HTMLButtonElement>();
  /**
   * Which explanations are open. On the instance, not in the DOM: panels are
   * rebuilt by `replaceChildren` every tick, and a DOM-held open state
   * closes itself every five seconds — the same reason the diplomacy, air
   * and regent forms are built once.
   */
  private readonly openHelp = new Set<HelpKey>();
  /** The bar's right-hand side, built with the bar. */
  private identity: HTMLElement | null = null;
  /** The in-game day and hour, beside the identity. */
  private clock: HTMLElement | null = null;
  /** The spectator's answer, built once and moved between panels. */
  private spectatorNote: HTMLElement | null = null;

  constructor(private readonly actions: HudActions) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement("div");
    this.root.id = "world-hud";
    this.buildMenu();
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

  private buildMenu(): void {
    const bar = document.createElement("nav");
    bar.id = "world-menu";

    // Something that says what this is. Six glyphs floating over a map do not
    // read as an interface, and there was nothing on screen naming the world.
    const brand = document.createElement("div");
    brand.className = "brand";
    const mark = document.createElement("b");
    mark.textContent = t("hud.brand");
    const sub = document.createElement("span");
    sub.textContent = t("hud.brandSub");
    brand.append(mark, sub);
    bar.append(brand);

    const entries: readonly [PanelId, string, StringKey][] = [
      ["economy", "📊", "economy.title"],
      ["queue", "🏗️", "queue.title"],
      ["production", "🏭", "production.title"],
      ["research", "🔬", "research.title"],
      ["diplomacy", "🤝", "diplomacy.title"],
      ["air", "✈️", "air.title"],
    ];
    for (const [id, glyph, label] of entries) {
      const button = document.createElement("button");
      button.type = "button";
      // Glyph *and* word. The glyph alone was a guessing game — 🏗️ and 🏭 are
      // the same picture at 15 pixels — and a button whose meaning has to be
      // hovered for is a button that gets pressed by accident or not at all.
      const icon = document.createElement("span");
      icon.className = "glyph";
      icon.textContent = glyph;
      const word = document.createElement("span");
      word.className = "label";
      word.textContent = t(label);
      button.append(icon, word);
      button.title = t(label);
      button.setAttribute("aria-label", t(label));
      button.setAttribute("aria-pressed", String(this.open === id));
      button.addEventListener("click", () => this.toggle(id));
      this.menuButtons.set(id, button);
      bar.appendChild(button);
    }

    // What time it is. Every rate on screen is per day and every estimate
    // is in days; until the bar said which day it was, none of them had a
    // scale a player could feel.
    this.clock = document.createElement("span");
    this.clock.className = "clock";
    bar.append(this.clock);

    // Who you are, on the right. Reading the URL used to be the only way.
    this.identity = document.createElement("div");
    this.identity.className = "who";
    bar.append(this.identity);

    this.root.appendChild(bar);
  }

  /**
   * A row or heading with a circled i on it, and its explanation under it
   * while open.
   *
   * The whole point is that it is *inline*: the player who could not work out
   * what "Resources covered 60%" meant needs the answer next to the number,
   * in the panel, not in a tooltip that needs a hover or a doc that needs a
   * tab. A click redraws from the last model at once, like the menu does.
   */
  private explained(key: HelpKey, element: HTMLElement): Node[] {
    const open = this.openHelp.has(key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "info";
    button.textContent = "i";
    button.title = t("hud.info");
    button.setAttribute("aria-label", t("hud.info"));
    button.setAttribute("aria-expanded", String(open));
    button.dataset.help = key;
    button.addEventListener("click", () => {
      if (this.openHelp.has(key)) this.openHelp.delete(key);
      else this.openHelp.add(key);
      if (this.lastModel !== null) this.update(this.lastModel);
    });
    // A row keeps its value flush right, so the i goes on the label span;
    // a heading takes it at the end.
    (element.querySelector(".muted") ?? element).append(button);
    if (!open) return [element];
    const help = document.createElement("div");
    help.className = "help";
    help.textContent = t(key);
    return [element, help];
  }

  /** Day and hour, from the tick alone (§4: one tick is one in-game hour). */
  private renderClock(model: HudModel): void {
    if (this.clock === null) return;
    this.clock.textContent = t("hud.clock", {
      day: Math.floor(model.tick / TICKS_PER_DAY),
      hour: String(model.tick % TICKS_PER_DAY).padStart(2, "0"),
    });
  }

  /** The bar's right-hand side: this nation, in its own colour, or watching. */
  private renderIdentity(model: HudModel): void {
    const box = this.identity;
    if (box === null) return;
    if (model.nation === null) {
      const note = document.createElement("span");
      note.textContent = t("hud.watching");
      box.replaceChildren(note);
      return;
    }
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = nationCss(model.nation);
    const name = document.createElement("span");
    name.textContent = nationName(model, model.nation);
    const flag = flagOf(model, model.nation);
    box.replaceChildren(...(flag === null ? [] : [flag]), swatch, name);
  }

  /**
   * What an open panel says when there is no nation to fill it.
   *
   * Every panel hid itself without one, so a spectator pressing a menu button
   * got no panel, no message and no reason — a button indistinguishable from a
   * broken one. This is the smallest honest answer: what you are, why the
   * panel is empty, and the way out.
   */
  private renderSpectator(model: HudModel): void {
    if (model.nation !== null || this.open === null) return;
    const panels: Record<PanelId, HTMLElement> = {
      economy: this.economyPanel,
      queue: this.queuePanel,
      production: this.productionPanel,
      research: this.researchPanel,
      diplomacy: this.diplomacyPanel,
      air: this.airPanel,
    };
    const panel = panels[this.open];
    // Built once and moved, not rebuilt. `update` runs on every delta, and a
    // button destroyed and recreated once a second loses keyboard focus every
    // second and drops a click that lands during the swap — the same reason
    // the diplomacy form is built once.
    if (this.spectatorNote === null) {
      const note = document.createElement("p");
      note.className = "spectator";
      note.textContent = t("hud.spectator");
      const choose = document.createElement("button");
      choose.type = "button";
      choose.textContent = t("hud.chooseNation");
      choose.addEventListener("click", () => this.actions.chooseNation());
      const box = document.createElement("div");
      box.append(heading(t("hud.watching")), note, choose);
      this.spectatorNote = box;
    }
    if (this.spectatorNote.parentElement !== panel) {
      panel.replaceChildren(this.spectatorNote);
    }
    panel.hidden = false;
  }

  /** Open a panel, or close it again if it was the open one. */
  private toggle(id: PanelId): void {
    this.open = this.open === id ? null : id;
    for (const [panel, button] of this.menuButtons) {
      button.setAttribute("aria-pressed", String(this.open === panel));
    }
    // Redraw from the last model rather than waiting for the next tick: five
    // seconds between click and panel would read as a broken button.
    //
    // `lastModel` is seeded by the client before the first state arrives, so
    // this holds even while the world is unreachable — otherwise the six
    // buttons set aria-pressed and did nothing at all, which is the exact
    // failure this panel rotation was built to avoid.
    if (this.lastModel !== null) this.update(this.lastModel);
  }

  update(model: HudModel): void {
    this.lastModel = model;
    this.renderEconomy(model);
    this.renderQueue(model);
    this.renderProvince(model);
    this.renderProduction(model);
    this.renderResearch(model);
    this.renderDiplomacy(model);
    this.renderAir(model);
    this.renderClock(model);
    this.renderIdentity(model);
    // Last, because it overrides a panel the renderers above just hid.
    this.renderSpectator(model);
  }

  // -------------------------------------------------------------------------

  private renderEconomy(model: HudModel): void {
    const economy = model.economy;
    this.economyPanel.hidden = economy === null || this.open !== "economy";
    if (economy === null) return;

    // **What the queue actually gets**, not what the factories made. Since
    // phase 7 the construction system spends `made - paid + earned`, and a
    // panel showing the gross figure was quietly promising a build speed the
    // world was not delivering — and the queue's own "days left" was computed
    // from it, so an import that halved the rate left the estimate twice as
    // optimistic with nothing on screen to explain it.
    const netConstruction = constructionNet(economy);
    const traded = economy.tradePointsIn - economy.tradePointsOut;

    if (this.economyList === null) {
      this.economyList = document.createElement("div");
      this.economyPanel.append(this.economyList);
    }
    this.economyList.replaceChildren(
      // **Whose economy this is, before what is in it.** A player who
      // cannot tell which nation they are looking at cannot use any other
      // number on the screen, and until this said so the only way to find out
      // was to read the URL.
      heading(
        model.nation === null
          ? t("economy.title")
          : nationName(model, model.nation),
      ),
      ...victoryLine(model),
      ...this.explained(
        "help.economy.construction",
        row(t("economy.construction"), perDay(netConstruction)),
      ),
      // Where it comes from. "Where does my construction come from" had no
      // answer on screen until the count was on the wire (protocol 17).
      muted(
        t("economy.civilianFactories", { count: economy.civilianFactories }),
      ),
      ...(Math.abs(traded) > 1e-9
        ? this.explained(
            "help.economy.tradeShare",
            row(t("economy.tradeShare"), perDay(traded)),
          )
        : []),
      ...this.explained(
        "help.economy.industry",
        row(t("economy.industry"), perDay(economy.industryPerTick)),
      ),
      ...this.explained(
        "help.economy.supplyRatio",
        row(t("economy.supplyRatio"), share(economy.sufficiency)),
      ),
      spacer(),
      ...this.explained(
        "help.economy.resources",
        heading(t("economy.resources")),
      ),
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
      // The door. The build menu lives in the province panel, which exists
      // only after a click on the map, and nothing on screen said so: a
      // player could read every number here and still not know how to build
      // anything. The queue says the same when it is empty.
      ...(model.nation === null
        ? []
        : [spacer(), hint(t("economy.howToBuild"))]),
    );
    this.buildRegentForm();
    this.syncRegentForm(model);
  }

  /**
   * The regent's controls, built once — a select mid-choice must not be
   * rebuilt under the player every five seconds (the diplomacy form's rule).
   * The budget is entered per in-game day (invariant 9) and sent per tick.
   */
  private buildRegentForm(): void {
    if (this.regentForm !== null) return;
    const form = document.createElement("div");

    const enabledRow = document.createElement("label");
    enabledRow.className = "row";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabledRow.append(document.createTextNode(t("regent.enabled")), enabled);

    const focus = document.createElement("select");
    for (const id of REGENT_FOCI) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = t(`regent.focus.${id}` as StringKey);
      focus.append(option);
    }

    const budget = document.createElement("input");
    budget.type = "number";
    budget.min = "0";
    budget.step = "1";
    // **A label, not a placeholder.** It was a placeholder, and a placeholder
    // is gone the moment the field has a value — which this one always does,
    // because it is filled from the world every tick. So the number sat there
    // unexplained, and the player's report was "I have no idea what this means
    // or does". A caption that disappears exactly when there is something to
    // caption is not a caption.
    const budgetLabel = document.createElement("label");
    budgetLabel.className = "field";
    budgetLabel.append(
      captionFor(t("regent.budget"), t("regent.budgetHint")),
      budget,
    );

    const focusLabel = document.createElement("label");
    focusLabel.className = "field";
    focusLabel.append(
      captionFor(t("regent.focus"), t("regent.focusHint")),
      focus,
    );

    const what = document.createElement("p");
    what.className = "hint";
    what.textContent = t("regent.what");

    const apply = document.createElement("button");
    apply.textContent = t("regent.apply");
    apply.addEventListener("click", () => {
      this.actions.configureRegent(
        enabled.checked,
        focus.value as RegentFocus,
        Number(budget.value || "0") / TICKS_PER_DAY,
      );
    });

    form.append(
      spacer(),
      heading(t("regent.title")),
      what,
      enabledRow,
      focusLabel,
      budgetLabel,
      apply,
    );
    this.regentForm = form;
    this.regentEnabled = enabled;
    this.regentFocus = focus;
    this.regentBudget = budget;
    this.economyPanel.append(form);
  }

  /** Show the server's answer — except in the field the player is using. */
  private syncRegentForm(model: HudModel): void {
    const regent = model.economy?.regent;
    if (regent === undefined) return;
    const active = document.activeElement;
    if (this.regentEnabled !== null && active !== this.regentEnabled) {
      this.regentEnabled.checked = regent.enabled;
    }
    if (this.regentFocus !== null && active !== this.regentFocus) {
      this.regentFocus.value = regent.focus;
    }
    if (this.regentBudget !== null && active !== this.regentBudget) {
      this.regentBudget.value = String(
        Math.round(regent.marketBudget * TICKS_PER_DAY),
      );
    }
  }

  private renderQueue(model: HudModel): void {
    const economy = model.economy;
    this.queuePanel.hidden = economy === null || this.open !== "queue";
    if (economy === null) return;

    const children: Node[] = [heading(t("queue.title"))];
    if (economy.queue.length === 0) {
      children.push(muted(t("queue.empty")), hint(t("queue.howToBuild")));
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
    const built = BUILDING_TYPES.reduce(
      (sum, type) =>
        BUILDINGS[type].takesSlot
          ? sum + model.buildings[id * stride + buildingIndex(type)]
          : sum,
      0,
    );
    // Queued orders hold their slot too — the server counts them (it would
    // refuse a second factory into the last slot), so the panel counts them,
    // or a button stays enabled that can only be refused.
    const queuedHere =
      model.economy?.queue.filter((order) => order.provinceId === id) ?? [];
    const used =
      built +
      queuedHere.filter((order) => BUILDINGS[order.building].takesSlot).length;
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

    // The war, for whoever is looking. `fronts` and `invasions` are public on
    // the wire — §7 keeps treaty terms private, not battles — and until now
    // the client used them only to paint tiles: a defender being ground
    // down read nothing here, and the map alone had to say so. The holder
    // also sees their own divisions standing in the province, with the two
    // numbers that decide the fight.
    const front = model.fronts.find((it) => it.province === id);
    if (front !== undefined && front.attacker !== controller) {
      children.push(
        spacer(),
        warn(
          front.attacker === model.nation
            ? t("province.frontOwn")
            : t("province.underAttack", {
                attacker: nationName(model, front.attacker),
              }),
        ),
      );
      const bar = document.createElement("div");
      bar.className = "bar front";
      const fill = document.createElement("div");
      fill.style.width = `${Math.min(100, front.progress * 100)}%`;
      fill.style.background = nationCss(front.attacker);
      bar.appendChild(fill);
      children.push(
        bar,
        muted(t("province.frontTaken", { share: share(front.progress) })),
      );
      // The numbers, for the two nations in the fight (decision 0023). Per
      // day, like everything else on screen; the wire is per tick.
      const battle = model.battles.find((it) => it.province === id);
      if (battle !== undefined) {
        children.push(
          heading(t("battle.title")),
          row(
            t("battle.strength"),
            t("battle.divisions", {
              attacker: amount(battle.attackerStrength),
              defender: amount(battle.defenderStrength),
            }),
          ),
          row(
            t("battle.modifiers"),
            `${percent(battle.terrain)} \u00b7 ${percent(battle.air)}`,
          ),
          row(
            t("battle.advance"),
            t("battle.perDay", {
              value: percent(battle.advancePerTick * TICKS_PER_DAY),
            }),
          ),
          row(
            t("battle.losses"),
            `${perDay(battle.attackerLossPerTick)} \u00b7 ${perDay(battle.defenderLossPerTick)}`,
          ),
        );
      }
    }
    const landing = model.invasions.find((it) => it.to === id);
    if (landing !== undefined) {
      // Invariant 9: days, rounded up like every other estimate on screen.
      const days = daysRemaining(landing.ticksLeft, 1);
      children.push(
        spacer(),
        warn(
          landing.attacker === model.nation
            ? t("province.invasionOwn", { days })
            : t("province.invasionIncoming", {
                attacker: nationName(model, landing.attacker),
                days,
              }),
        ),
      );
    }
    if (
      model.nation !== null &&
      controller === model.nation &&
      model.economy !== null
    ) {
      const here = model.economy.divisions.filter(
        (division) => division.provinceId === id,
      );
      if (here.length > 0) {
        children.push(spacer(), heading(t("province.defenders")));
        for (const division of here) {
          children.push(
            muted(
              t("province.divisionLine", {
                id: division.id,
                strength: share(division.strength),
                supply: share(division.supply),
              }),
            ),
          );
        }
      }
    }

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
      const attacking =
        model.economy?.attacks.some((attack) => attack.province === id) ===
        true;
      const button = document.createElement("button");
      button.textContent = attacking
        ? t("province.callOff")
        : t("province.attack");
      button.addEventListener("click", () =>
        attacking ? this.actions.cancelAttack(id) : this.actions.claim(id),
      );

      // §6.8's other way in: a hostile coast can be invaded from the sea.
      // The division is chosen for the player — the strongest one standing
      // on a coast the nation holds — because invariant 4 wants allocation,
      // not unit-picking, and the server refuses anything unseaworthy.
      const invader =
        province.seaZone === null || model.economy === null
          ? undefined
          : model.economy.divisions
              .filter((division) => {
                const at = model.provinces[division.provinceId];
                return (
                  at !== undefined &&
                  at.seaZone !== null &&
                  model.controllers[division.provinceId] === model.nation &&
                  !model.economy?.seaTransits.some(
                    (transit) => transit.divisionId === division.id,
                  )
                );
              })
              .sort((a, b) => b.strength - a.strength)[0];
      if (invader !== undefined) {
        const invade = document.createElement("button");
        invade.textContent = t("province.invade");
        invade.addEventListener("click", () =>
          this.actions.navalInvade(invader.id, id),
        );
        button.insertAdjacentElement("afterend", invade);
      }
      children.push(spacer(), button);
      if (attacking) children.push(muted(t("province.attacking")));
    }

    // The build menu is shown wherever the nation *holds* the province, and
    // every button that would be refused says why. It used to appear only
    // where a building could actually go, and vanish on a province the
    // player held but did not own — which is exactly the province a player
    // looks at after taking one, and it looked like the menu had broken. A
    // door with a sign on it teaches more than no door.
    if (model.nation !== null && controller === model.nation) {
      const occupied = owner !== model.nation;
      const manpower = model.economy?.manpower ?? 0;
      const raise = document.createElement("button");
      raise.textContent = t("production.raise", { cost: DIVISION_MANPOWER });
      explain(
        raise,
        occupied
          ? t("build.occupied")
          : manpower < DIVISION_MANPOWER
            ? t("build.needsManpower", {
                cost: DIVISION_MANPOWER,
                have: Math.floor(manpower),
              })
            : null,
      );
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
        explain(
          button,
          occupied
            ? t("build.occupied")
            : manpower < WING_MANPOWER
              ? t("build.needsManpower", {
                  cost: WING_MANPOWER,
                  have: Math.floor(manpower),
                })
              : null,
        );
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
        // Each refusal is written on the button: a greyed button with no
        // reason is a puzzle, and this panel had eight of them.
        const pendingOfType = queuedHere.filter(
          (order) => order.building === type,
        ).length;
        const existing =
          type === "infrastructure"
            ? province.infrastructure + builtInfrastructure
            : model.buildings[id * stride + buildingIndex(type)];
        explain(
          button,
          occupied
            ? t("build.occupied")
            : spec.coastalOnly && !province.coastal
              ? t("build.notCoastal")
              : spec.takesSlot && used >= province.buildingSlots
                ? t("build.noSlot")
                : spec.maxPerProvince !== undefined &&
                    existing + pendingOfType >= spec.maxPerProvince
                  ? t("build.maxed", { max: spec.maxPerProvince })
                  : null,
        );
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
    this.productionPanel.hidden =
      economy === null || this.open !== "production";
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
      for (const attack of economy.attacks) {
        const item = document.createElement("div");
        item.className = "line";
        // The front is a rate now (invariant 1), so the list can say how far
        // in it is instead of only that it exists.
        item.append(
          row(
            t("province.title", { id: attack.province }),
            share(attack.progress),
          ),
        );
        const off = document.createElement("button");
        off.textContent = t("province.callOff");
        off.addEventListener("click", () =>
          this.actions.cancelAttack(attack.province),
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
      const transit = economy.seaTransits.find(
        (it) => it.divisionId === division.id,
      );
      children.push(
        row(
          transit !== undefined
            ? t("production.atSea", {
                id: division.id,
                // Invariant 9: days, never ticks. Rounded up like the queue.
                days: daysRemaining(transit.ticksLeft, 1),
              })
            : t("production.divisionAt", {
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
    this.researchPanel.hidden = economy === null || this.open !== "research";
    if (economy === null) return;

    // The sentence this panel was missing. A list of slots and a list of
    // techs does not say that one goes into the other, or that it is free.
    const children: Node[] = [
      ...this.explained("help.research.slots", heading(t("research.title"))),
      hint(t("research.how")),
    ];
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
    children.push(
      spacer(),
      ...this.explained(
        "help.research.techs",
        heading(t("research.available")),
      ),
    );
    for (const id of offered) {
      const ready = isAvailable(id, economy.unlockedTechs);
      const button = document.createElement("button");
      const days = Math.ceil(TECHS[id].ticks / 24);
      button.textContent = `${t(`tech.${id}` as StringKey)} — ${days}d`;
      // What it does, under the name. The effect was on the config the HUD
      // already imported and was shown nowhere, so "why research this" had
      // no answer on screen.
      const effect = document.createElement("span");
      effect.className = "effect";
      effect.textContent = effectLine(TECHS[id].effect);
      button.append(effect);
      explain(
        button,
        !ready
          ? t("research.needs", {
              techs: TECHS[id].requires
                .filter((need) => !known.has(need))
                .map((need) => t(`tech.${need}` as StringKey))
                .join(", "),
            })
          : free < 0
            ? t("research.noSlot")
            : null,
      );
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
    this.diplomacyPanel.hidden =
      nation === null || model.economy === null || this.open !== "diplomacy";
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
      const label = `${nationWithRuler(model, id)} — ${t(
        "diplomacy.trustShort",
        { trust: amount(model.trust[id] ?? 0) },
      )}`;
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
    this.airPanel.hidden = economy === null || this.open !== "air";
    if (economy === null) return;

    if (this.airList === null) {
      this.airList = document.createElement("div");
      this.airPanel.append(this.airList);
    }

    const children: Node[] = [
      ...this.explained("help.air.zones", heading(t("air.title"))),
    ];

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

    children.push(
      spacer(),
      ...this.explained("help.air.base", heading(t("air.formations"))),
      // The airfield rule, said rather than discovered. The server has
      // enforced it since phase 8; the dropdown below greys the zones it
      // would refuse.
      ...this.explained("help.air.reach", hint(t("air.reachHint"))),
    );
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

    // **The form takes a zone kind, §6.8's phase-9 sentence for the UI**: it
    // is derived from the chosen formation's template, and the zone and
    // mission lists follow it. A fleet is offered sea zones and sea
    // missions, a wing the sky's — one form, two theatres (invariant 5).
    const chosenFormation = economy.formations.find(
      (formation) => String(formation.id) === which.value,
    );
    const template = chosenFormation?.template;
    const kind = template === undefined ? "air" : FORMATIONS[template].kind;

    // Every zone of the right kind the nation can see. Out-of-reach ones are
    // left in but greyed, with the same `zoneInReach` the server applies —
    // so the rule is visible before the refusal, and a zone that vanished
    // mid-click would be worse than one that says it cannot be chosen. The
    // server still answers, and its answer is the one that counts (§7).
    const zoneChosen = zone.value;
    const zones = economy.zones
      .filter((view) => view.kind === kind)
      .map((view) => {
        const label = t(kind === "air" ? "air.zone" : "air.seaZone", {
          zone: view.zone,
        });
        const reachable =
          chosenFormation === undefined ||
          model.provinces.length === 0 ||
          zoneInReach(model, chosenFormation.baseProvinceId, view.zone, kind);
        return {
          value: String(view.zone),
          label: reachable ? label : `${label} — ${t("air.outOfReach")}`,
          disabled: !reachable,
        };
      });
    syncOptions(zone, zones);
    if (zones.some((option) => option.value === zoneChosen)) {
      zone.value = zoneChosen;
    }

    const mission = this.airMission;
    if (mission !== null) {
      const missionChosen = mission.value;
      const missions = MISSIONS_BY_KIND[kind].map((id) => ({
        value: id,
        label: t(`mission.${id}` as StringKey),
      }));
      syncOptions(mission, missions);
      if (missions.some((option) => option.value === missionChosen)) {
        mission.value = missionChosen;
      }
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
    this.airMission = mission;
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
      option.textContent = `${nationWithRuler(model, other.smallID)} — ${t(
        "diplomacy.trustShort",
        { trust: amount(model.trust[other.smallID] ?? 0) },
      )}`;
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

/**
 * Where the season stands, in one line everyone shares (§10). Empty while
 * nobody is near the threshold — most of a season, by design.
 */
function victoryLine(model: HudModel): Node[] {
  const victory = model.victory;
  const names = (members: number[]): string =>
    members.map((member) => nationName(model, member)).join(", ");
  if (victory.winner !== null) {
    return [
      warn(
        t("victory.won", {
          bloc: names(victory.winner.members),
          how: t(`victory.${victory.winner.reason}` as StringKey),
        }),
      ),
      spacer(),
    ];
  }
  if (victory.holders !== null) {
    return [
      warn(t("victory.holding", { bloc: names(victory.holders) })),
      spacer(),
    ];
  }
  return [];
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
  wanted: { value: string; label: string; disabled?: boolean }[],
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
      option.disabled = entry.disabled === true;
      select.append(option);
    } else {
      if (existing.textContent !== entry.label)
        existing.textContent = entry.label;
      existing.disabled = entry.disabled === true;
    }
  }
}

/**
 * A field's caption: what it is, and one line on what it does.
 *
 * Above the control, never inside it. The hint is the part that was missing
 * everywhere in this form — the names alone ("Focus", "Market budget a day")
 * name the setting without saying what changes when you touch it.
 */
function captionFor(label: string, hint: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const name = document.createElement("span");
  name.className = "caption";
  name.textContent = label;
  const note = document.createElement("span");
  note.className = "hint";
  note.textContent = hint;
  fragment.append(name, note);
  return fragment;
}

/**
 * Disable a button and say why, on the button itself.
 *
 * A `title` alone is not enough: the HUD is rebuilt every tick, the root is
 * pointer-events:none, and a touch screen has no hover. The reason goes
 * under the label where it is read at the moment the button fails to work.
 * With no reason the button is left exactly as it was.
 */
function explain(button: HTMLButtonElement, reason: string | null): void {
  if (reason === null) return;
  button.disabled = true;
  button.title = reason;
  const why = document.createElement("span");
  why.className = "why";
  why.textContent = reason;
  button.append(why);
}

/**
 * A tech's effect as the player reads it: signed percentages (invariant 9),
 * except a slot, which is a count.
 */
function effectLine(effect: TechEffect): string {
  const parts: string[] = [];
  const ratio = (key: StringKey, value: number | undefined): void => {
    if (value !== undefined) parts.push(t(key, { value: percent(value) }));
  };
  ratio("effect.factoryOutput", effect.factoryOutput);
  ratio("effect.efficiencyCap", effect.efficiencyCap);
  ratio("effect.extraction", effect.extraction);
  ratio("effect.construction", effect.construction);
  ratio("effect.reinforceRate", effect.reinforceRate);
  ratio("effect.defenderLoss", effect.defenderLoss);
  if (effect.researchSlots !== undefined) {
    parts.push(
      t("effect.researchSlots", { value: `+${effect.researchSlots}` }),
    );
  }
  return parts.join(" \u00b7 ");
}

/**
 * A nation with the name of whoever runs it — the regent's persona, derived
 * on the server from the world seed (decision 0023). The player's own nation
 * is shown by name alone: they are not their regent.
 */
function nationWithRuler(model: HudModel, id: number): string {
  const nation = model.nations.find((n) => n.smallID === id);
  if (nation === undefined) return `#${id}`;
  if (id === model.nation) return nation.name;
  return t("nation.withRuler", { name: nation.name, ruler: nation.ruler });
}

/** The nation's flag from the map manifest, or null when the map has none. */
function flagOf(model: HudModel, id: number): HTMLElement | null {
  const flag = model.nations.find((n) => n.smallID === id)?.flag;
  if (flag === undefined) return null;
  const img = document.createElement("img");
  img.className = "flag";
  img.alt = "";
  img.src = `/flags/${flag}.svg`;
  // A deployment that does not ship `resources/flags` shows no flag rather
  // than a broken image.
  img.addEventListener("error", () => img.remove());
  return img;
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

function warn(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "warn";
  element.textContent = text;
  return element;
}

/** One explanatory line, quieter than a row: what to do, or what this is. */
function hint(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "hint";
  element.textContent = text;
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
