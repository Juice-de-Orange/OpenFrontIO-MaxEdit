/**
 * The world client's entry point.
 *
 * Canvas, map, palette, renderer, camera, data source — in that order, and
 * nothing else. No lobby, no modals, no simulation.
 *
 * Two things about the renderer that cost time if got wrong:
 *
 * **Do not pass raf/caf.** GPURenderer starts its own loop in its constructor.
 * ClientGameRunner intercepts the callback only because it had a second
 * canvas2D loop to stay in step with; there is no second loop here, and
 * supplying a capture plus running one's own gives two.
 *
 * **The loop is not optional.** TerritoryPass drains one drip bucket per
 * rendered frame (bucketCount 9), so a tile delta needs nine frames to land.
 * Drawing once per server tick would leave territory looking frozen.
 */

import { uploadFrameData } from "src/client/render/frame/Upload";
import { MapRenderer, preloadAtlasData } from "src/client/render/gl";
import { createRenderSettings } from "src/client/render/gl/RenderSettings";
import type { RenderRules } from "src/client/render/types";
import { ALL_UNIT_TYPES, PlayerTypeEnum } from "src/client/render/types";
import { TICK_MS } from "src/shared/config/time";
import { BUILDING_TYPES } from "src/shared/economy/Buildings";
import { FORMATIONS } from "src/shared/economy/Formations";
import type { ProvinceMap } from "src/shared/map/ProvinceMap";
import type { FullState } from "src/shared/protocol/Wire";
import { zoneUnder } from "./AreaPicker";
import { CameraController } from "./CameraController";
import { FrameAdapter } from "./FrameAdapter";
import { loadWorldMap } from "./MapAssets";
import { buildPalette } from "./Palette";
import {
  borderLayerImages,
  PROVINCE_BORDER_LAYER,
  PROVINCE_BORDER_LAYERS,
} from "./ProvinceBorders";
import { ProvinceTileIndex } from "./ProvinceTileIndex";
import { Hud, type HudModel } from "./ui/Hud";
import { fetchOffer, showStartScreen } from "./ui/StartScreen";
import { setLanguage, t } from "./ui/strings";
import { WorldSocket } from "./WorldSocket";
import { zoneAnchors, type ZoneAnchors } from "./ZoneAnchors";
import { ZONE_LAYERS, zoneLayerImages } from "./ZoneBorders";

const DEFAULT_WORLD = "world-0";

/**
 * Which nation this browser plays.
 *
 * From the query string, because phase 1 has no accounts and no nation
 * registration screen. `?nation=` absent means watching: the world will accept
 * the connection and refuse any order it sends.
 */
function nationFromUrl(): number | null {
  const raw = new URLSearchParams(location.search).get("nation");
  if (raw === null) return null;
  const nation = Number.parseInt(raw, 10);
  return Number.isInteger(nation) && nation > 0 ? nation : null;
}

/** Same-origin, so dev and production use one URL shape. */
function worldSocketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

/**
 * Phase-0 rules. Every value here is a placeholder that moves to
 * shared/config/ when the world server owns it.
 */
const rules: RenderRules = {
  msPerTick: () => TICK_MS,
  unitInfo: () => ({}),
  warshipVeterancyHealthBonus: () => 0,
  deletionMarkDuration: () => 1,
  SAMCooldown: () => 1,
  SiloCooldown: () => 1,
  allianceExtensionPromptOffset: () => 0,
};

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.id = "world-canvas";
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  document.body.appendChild(canvas);
  return canvas;
}

/**
 * A line of feedback that goes away by itself.
 *
 * Every command is answered, and an answer nobody can see is not an answer.
 * This is the smallest thing that shows one; phase 3 brings a real HUD.
 */
function showNotice(message: string): void {
  let box = document.getElementById("world-notice");
  if (box === null) {
    box = document.createElement("div");
    box.id = "world-notice";
    box.style.cssText =
      "position:fixed;left:1rem;bottom:1rem;max-width:24rem;padding:.5rem .75rem;" +
      "background:rgba(20,20,20,.85);color:#eee;font:13px system-ui;border-radius:4px;" +
      "pointer-events:none;z-index:9";
    document.body.appendChild(box);
  }
  box.textContent = message;
  const shown = box;
  window.setTimeout(() => {
    if (shown.textContent === message) shown.textContent = "";
  }, 4000);
}

/**
 * The end of the road, with a way off it where there is one.
 *
 * A fatal used to be a sentence on a grey field. That is right for a protocol
 * mismatch and wrong for "that nation is not yours", which is a thing the
 * player can simply fix — so a refusal offers the chooser instead of leaving
 * them to work out that reloading might help.
 */
function showFatal(message: string, again?: { label: string }): void {
  document.getElementById("world-error")?.remove();
  const box = document.createElement("div");
  box.id = "world-error";
  box.style.cssText =
    "position:fixed;inset:0;display:flex;flex-direction:column;gap:1rem;" +
    "align-items:center;justify-content:center;background:#14171d;color:#e8ecf3;" +
    "font:15px/1.5 system-ui;padding:2rem;text-align:center;z-index:50";
  const text = document.createElement("p");
  text.style.cssText = "margin:0;max-width:34rem";
  text.textContent = message;
  box.append(text);
  if (again !== undefined) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = again.label;
    button.style.cssText =
      "padding:.55rem 1.1rem;font:inherit;color:inherit;cursor:pointer;" +
      "background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);" +
      "border-radius:8px";
    button.addEventListener("click", () => startOver());
    box.append(button);
  }
  document.body.appendChild(box);
}

/** Where this browser keeps the nation it chose. */
const NATION_KEY = "world.nation";
/** And the credential that nation belongs to. */
const TOKEN_KEY = "world.account.token";

/**
 * The value `NATION_KEY` carries for "I chose to watch".
 *
 * A choice, remembered like any other. Without it the chooser reappeared over
 * the map on every reload, and the only way to make it stop was to pick a
 * nation — which is the opposite of what the player said.
 */
const WATCHING = -1;

/**
 * Whether this browser will actually keep what it is told to keep.
 *
 * Every storage call here is wrapped in a try, and treating a failure as
 * cosmetic is what makes it dangerous: on a season world, picking a nation
 * with no storage registers a throwaway account, claims the nation for it
 * *for the whole season*, and loses the token on reload. The nation is then
 * held by an account nobody can ever sign in as, and the next load burns
 * another one. Probed rather than assumed, because the failure is silent.
 */
function storageWorks(): boolean {
  try {
    const probe = "world.probe";
    localStorage.setItem(probe, "1");
    const back = localStorage.getItem(probe);
    localStorage.removeItem(probe);
    return back === "1";
  } catch {
    return false;
  }
}

/** Drop the token: the account it names does not exist. */
function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Then the next load asks the server again and is told the same thing,
    // which is a loop the player can break by clearing site data. Storage
    // that refuses to forget is rare enough not to design around.
  }
}

/** The account token this browser holds, if it has one. */
function heldToken(): string | null {
  try {
    const held = localStorage.getItem(TOKEN_KEY);
    return held !== null && held.length > 0 ? held : null;
  } catch {
    return null;
  }
}

function rememberWatching(): void {
  try {
    localStorage.setItem(NATION_KEY, String(WATCHING));
  } catch {
    // Then it asks again next time, which is a nuisance rather than a fault.
  }
}

function rememberedNation(): number | null {
  try {
    const raw = localStorage.getItem(NATION_KEY);
    if (raw === null) return null;
    const nation = Number.parseInt(raw, 10);
    if (nation === WATCHING) return WATCHING;
    return Number.isInteger(nation) && nation > 0 ? nation : null;
  } catch {
    return null;
  }
}

function rememberNation(nation: number): void {
  try {
    localStorage.setItem(NATION_KEY, String(nation));
  } catch {
    // Storage can be blocked. The choice then lasts for this page only, which
    // is worse than remembering it and better than refusing to start.
  }
}

function forgetNation(): void {
  try {
    localStorage.removeItem(NATION_KEY);
  } catch {
    // Nothing to undo.
  }
}

/**
 * Forget the nation and come back to the chooser.
 *
 * The `?nation=` has to go with it. It takes precedence over everything the
 * browser remembers — deliberately, so a gate or a second window can address a
 * world directly — which means a player refused on a `?nation=` URL would
 * otherwise press "choose a nation" and reload into the identical refusal, for
 * ever. `docs/deploy/README.md` hands out exactly such URLs.
 *
 * `reason` survives the reload in sessionStorage, so the chooser can open with
 * the refusal on it rather than pretending nothing happened.
 */
function startOver(reason?: string): void {
  forgetNation();
  if (reason !== undefined) {
    try {
      sessionStorage.setItem(PROBLEM_KEY, reason);
    } catch {
      // The reason is a courtesy; losing it must not stop the recovery.
    }
  }
  const url = new URL(location.href);
  url.searchParams.delete("nation");
  location.replace(url.toString());
}

/** Why the last attempt failed, if it did. Read once, then cleared. */
const PROBLEM_KEY = "world.problem";

function takeProblem(): string | undefined {
  try {
    const held = sessionStorage.getItem(PROBLEM_KEY);
    if (held === null) return undefined;
    sessionStorage.removeItem(PROBLEM_KEY);
    return held;
  } catch {
    return undefined;
  }
}

/**
 * Which nation this page is going to play, asking the player if need be.
 *
 * Order matters. An explicit `?nation=` wins and is deliberately *not*
 * remembered — it is how the gates and a second browser window address a
 * world, and persisting it would make a debugging URL into a commitment. Then
 * what this browser chose last time. Only then does anybody get asked.
 */
/** The nation to play and, when the browser has no account yet, the name to register with. */
async function chooseNation(): Promise<{
  nation: number | null;
  name: string;
}> {
  const fromUrl = nationFromUrl();
  if (fromUrl !== null) return { nation: fromUrl, name: "" };

  const remembered = rememberedNation();
  if (remembered === WATCHING) return { nation: null, name: "" };
  if (remembered !== null) return { nation: remembered, name: "" };

  // The token before the question: an account that already holds a nation is
  // not being asked to choose one, it is being let back in.
  const offer = await fetchOffer(heldToken());
  if (offer === null) {
    // No list means no chooser. Watching still works, and saying so beats a
    // blank screen while the world is plainly drawing itself behind it.
    showNotice(t("start.offline"));
    return { nation: null, name: "" };
  }
  if (offer.yours !== null) {
    rememberNation(offer.yours);
    return { nation: offer.yours, name: "" };
  }

  // A season world asks for a commitment the browser has to be able to keep.
  const keeps = storageWorks();
  const choice = await showStartScreen(offer, {
    problem: keeps ? takeProblem() : t("start.noStorage"),
    locked: offer.season && !keeps,
    // A browser that already holds an account has a name; only a new one is asked.
    named: heldToken() === null,
  });
  if (choice.kind === "watch") {
    // Remembered too, or the modal blocks the door on every reload with no
    // way to say "stop asking". The bar's own button is the way back in.
    rememberWatching();
    return { nation: null, name: "" };
  }
  rememberNation(choice.nation);
  return { nation: choice.nation, name: choice.name };
}

export async function startWorldClient(
  worldId: string = DEFAULT_WORLD,
): Promise<void> {
  // Both before the renderer is constructed, and awaited: NamePass and
  // StructureLevelPass parse the MSDF atlas in their constructors and throw
  // "Atlas data not loaded" if it has not arrived.
  await preloadAtlasData();

  let view: MapRenderer | undefined;
  let adapter: FrameAdapter | undefined;
  let anchors: ZoneAnchors = { air: new Map(), sea: new Map() };
  let camera: CameraController | null = null;
  let staleTokenHandled = false;
  let zoneSource: ProvinceMap | null = null;
  let mapSize = { width: 0, height: 0 };
  /**
   * Set when the renderer could not be built — no GPU context, a map
   * mismatch. The HUD keeps updating without a map behind it, so the
   * player still gets numbers and the reason, rather than a blank page.
   */
  let rendererFailed = false;

  // The nation, from the URL, from what this browser chose last time, or by
  // asking. Before this the URL was the only way and a visitor without one
  // landed in a spectator seat with nothing on screen to say why.
  const { nation, name } = await chooseNation();
  // Phase 11: the account token, if this browser has one. A season world
  // requires it to play; a workbench world carries it and ignores it. No
  // token yet and a nation wanted: register once and keep the credential —
  // losing it means a new account, which is the whole account system.
  const token = await ensureToken(nation, name);

  /**
   * Everything the HUD draws from.
   *
   * The client keeps no state the server did not send it: this is a copy of
   * the last full state with every delta since applied to it, and nothing is
   * computed here that the server did not already decide.
   */
  const model: HudModel = {
    nation,
    nations: [],
    provinces: [],
    controllers: [],
    owners: [],
    buildings: [],
    economy: null,
    trust: [],
    agreements: [],
    victory: { holders: null, heldSinceTick: null, winner: null },
    fronts: [],
    invasions: [],
    battles: [],
    tick: 0,
    selected: null,
  };

  const send = (command: Parameters<WorldSocket["sendCommand"]>[0]): void => {
    if (nation === null) {
      showNotice(t("hud.watching"));
      return;
    }
    if (socket.sendCommand(command) === null) {
      showNotice(t("hud.notConnected"));
    }
  };

  const hud = new Hud({
    claim: (province) => send({ kind: "claim_province", provinceId: province }),
    build: (province, building) =>
      send({ kind: "queue_construction", provinceId: province, building }),
    cancel: (orderId) => send({ kind: "cancel_construction", orderId }),
    openLine: (equipment) =>
      send({ kind: "create_production_line", equipment }),
    closeLine: (lineId) => send({ kind: "remove_production_line", lineId }),
    assignFactories: (lineId, factories) =>
      send({ kind: "assign_factories", lineId, factories }),
    switchLine: (lineId, equipment) =>
      send({ kind: "switch_production_line", lineId, equipment }),
    raiseDivision: (province) =>
      send({ kind: "raise_division", provinceId: province }),
    startResearch: (slot, tech) => send({ kind: "start_research", slot, tech }),
    cancelResearch: (slot) => send({ kind: "cancel_research", slot }),
    changeLanguage: (language) => {
      setLanguage(language);
      // The built-once forms keep their labels until the page is rebuilt,
      // and a reload costs nothing here: the state is the server's.
      window.location.reload();
    },
    cancelAttack: (province) =>
      send({ kind: "cancel_attack", provinceId: province }),
    navalInvade: (divisionId, province) =>
      send({ kind: "naval_invade", divisionId, provinceId: province }),
    configureRegent: (enabled, focus, marketBudget) =>
      send({ kind: "configure_regent", enabled, focus, marketBudget }),
    propose: (to, type, terms) =>
      send({ kind: "propose_agreement", to, type, terms }),
    acceptAgreement: (agreementId) =>
      send({ kind: "accept_agreement", agreementId }),
    declineAgreement: (agreementId) =>
      send({ kind: "decline_agreement", agreementId }),
    cancelAgreement: (agreementId) =>
      send({ kind: "cancel_agreement", agreementId }),
    setMarketOrder: (resource, perTick) =>
      send({ kind: "set_market_order", resource, perTick }),
    raiseFormation: (province, template) =>
      send({ kind: "raise_formation", provinceId: province, template }),
    assignFormation: (formationId, zone, mission) =>
      send({ kind: "assign_formation", formationId, zone, mission }),
    drawAreaFor: (formationId) => {
      const formation = model.economy?.formations.find(
        (f) => f.id === formationId,
      );
      if (formation === undefined || camera === null || zoneSource === null) {
        return;
      }
      const kind = FORMATIONS[formation.template].kind;
      const box = drawnBox();
      showNotice(t("air.drawing"));
      camera.drawArea(
        (area) => {
          box.remove();
          if (area === null) return;
          const zone = zoneUnder(
            zoneSource as ProvinceMap,
            mapSize.width,
            mapSize.height,
            area,
            kind,
          );
          if (zone === null) {
            showNotice(t("air.drawNothing"));
            return;
          }
          // The order a drawn area means: hold this water, or own this sky.
          // The other of the two is a choice the panel still offers.
          send({
            kind: "assign_formation",
            formationId,
            zone,
            mission: kind === "naval" ? "patrol" : "air_superiority",
          });
        },
        (area) => paintBox(box, area, camera as CameraController),
      );
    },
    disbandFormation: (formationId) =>
      send({ kind: "disband_formation", formationId }),
    // Forget and start over. A reload rather than re-entering the boot path:
    // choosing a nation changes the hello, and the hello is the first thing
    // the socket sends — reconnecting with a different one means a new
    // connection, a new full state and a new renderer anyway.
    chooseNation: () => startOver(),
  });

  // Draw once before anything has arrived. The HUD only redraws a menu click
  // from its last model, and that was set by the first full state — so with
  // the world unreachable the six buttons pressed, lit up and did nothing at
  // all. Now they open a panel that says why it is empty.
  hud.update(model);

  // A click selects. It used to claim, which meant the only thing a player
  // could do to a province was take it — there was nowhere to put a build
  // menu, and no way to look at a neighbour without attacking it.
  const pickProvince = (province: number): void => {
    model.selected = province;
    hud.update(model);
  };

  const socket: WorldSocket = new WorldSocket(
    worldSocketUrl(),
    worldId,
    nation,
    {
      onFullState: (state) => {
        model.nations = state.nations;
        model.controllers = [...state.controllers];
        model.owners = [...state.owners];
        model.buildings = [...state.buildings];
        model.economy = state.economy;
        model.trust = [...state.trust];
        model.agreements = state.agreements;
        model.victory = state.victory;
        model.fronts = state.fronts;
        model.invasions = state.invasions;
        // This tick's report is not on the full state; the next delta brings one.
        model.battles = [];
        model.tick = state.tick;

        if (!view || !adapter) {
          // First full state carries the map identity, so the renderer cannot
          // be built before it arrives.
          void buildFrom(state, pickProvince)
            .then((built) => {
              view = built.view;
              adapter = built.adapter;
              anchors = built.anchors;
              camera = built.camera;
              zoneSource = built.grid;
              mapSize = built.mapSize;
              model.provinces = built.provinces;
              adapter.applyFullState(state.controllers, state.tick);
              adapter.applyFronts(state.fronts, model.controllers);
              adapter.applyMarkers(
                model.fronts,
                model.invasions,
                model.controllers,
                model.provinces,
                model.nation,
              );
              adapter.applyBuildings(model.buildings, model.controllers);
              adapter.applyForces(
                model.nation,
                model.economy?.divisions ?? [],
                model.economy?.formations ?? [],
                anchors,
              );
              adapter.applyLabels(
                model.controllers,
                model.provinces,
                model.nations,
              );
              uploadFrameData(view, adapter.frameData());
              hud.update(model);
            })
            .catch((error: unknown) => {
              // A rejected build used to be an unhandled promise and a page
              // that stayed blank with a full state in hand. Say what went
              // wrong, and keep the panels alive — the economy needs no GPU.
              rendererFailed = true;
              showFatal(error instanceof Error ? error.message : String(error));
              hud.update(model);
            });
          return;
        }
        adapter.applyFullState(state.controllers, state.tick);
        adapter.applyFronts(state.fronts, model.controllers);
        adapter.applyMarkers(
          model.fronts,
          model.invasions,
          model.controllers,
          model.provinces,
          model.nation,
        );
        adapter.applyBuildings(model.buildings, model.controllers);
        adapter.applyForces(
          model.nation,
          model.economy?.divisions ?? [],
          model.economy?.formations ?? [],
          anchors,
        );
        adapter.applyLabels(model.controllers, model.provinces, model.nations);
        uploadFrameData(view, adapter.frameData());
        hud.update(model);
      },
      onDelta: (delta) => {
        // Ownership and the economy are tracked whether or not the renderer
        // is up; the map is not drawn until it is.
        for (const [province, holder] of delta.control) {
          model.controllers[province] = holder;
        }
        for (const [province, owner] of delta.owner) {
          model.owners[province] = owner;
        }
        for (const [province, building, count] of delta.buildings) {
          model.buildings[province * BUILDING_TYPES.length + building] = count;
        }
        model.economy = delta.economy;
        model.trust = delta.trust;
        // Replaced whole rather than merged: the server sends every agreement
        // this session may see on every tick, and an offer that arrived is the
        // one thing a diff would be unforgivable for losing.
        model.agreements = delta.agreements;
        model.victory = delta.victory;
        model.fronts = delta.fronts;
        model.invasions = delta.invasions;
        model.battles = delta.battles;
        model.tick = delta.tick;

        if (!view || !adapter) {
          // Full state still loading — or the renderer failed, in which case
          // the panels are all there is and they still get every tick.
          if (rendererFailed) hud.update(model);
          return;
        }
        // Control, not ownership: the map shows where the line is, not who
        // holds the title deeds (docs/decisions/0002).
        adapter.applyDelta(delta.control, delta.tick);
        // After the base ownership, so a repainted province gets its front
        // back — and a front that shrank or ended gets unwound.
        adapter.applyFronts(delta.fronts, model.controllers);
        adapter.applyMarkers(
          model.fronts,
          model.invasions,
          model.controllers,
          model.provinces,
          model.nation,
        );
        // Buildings only when something about them moved: a count, or the
        // controller whose colour they wear. Most ticks move neither.
        if (delta.buildings.length > 0 || delta.control.length > 0) {
          adapter.applyBuildings(model.buildings, model.controllers);
          adapter.applyLabels(
            model.controllers,
            model.provinces,
            model.nations,
          );
        }
        // **Every tick**, unlike the buildings: an army moves, fills and
        // is sent somewhere far more often than a factory finishes, and a
        // marker that lags a tick behind the panel is worse than none.
        adapter.applyForces(
          model.nation,
          model.economy?.divisions ?? [],
          model.economy?.formations ?? [],
          anchors,
        );
        uploadFrameData(view, adapter.frameData());
        hud.update(model);
      },
      onAck: (ack) => {
        showNotice(
          ack.accepted
            ? t("hud.orderAccepted")
            : t("hud.orderRefused", { reason: ack.reason ?? "" }),
        );
      },
      // The account this browser holds is gone — the world was reset under
      // it. Forget the token so the next claim registers a new account
      // rather than failing on every nation for ever.
      onStaleToken: () => {
        forgetToken();
        // Straight back to the chooser with a sentence that says what
        // happened, rather than the server's — "that token belongs to no
        // account" is true and tells a player nothing they can act on.
        startOver(t("start.staleToken"));
        staleTokenHandled = true;
      },
      onFatal: (message, refused) => {
        // The stale-token path has already said its piece and reloaded.
        if (staleTokenHandled) return;
        if (refused === true) {
          // Straight back to the chooser with the reason on it. A fatal screen
          // in between adds a click and says nothing the chooser cannot.
          startOver(t("start.refused", { reason: message }));
          return;
        }
        showFatal(message);
      },
    },
    token,
  );
}

/**
 * The account token for this browser, made on first need (phase 11).
 *
 * Kept in localStorage: the token *is* the account, there is no password
 * and no recovery, and a browser that loses its storage starts a new
 * account — which on a season world means a new nation, because the old
 * one stays claimed. Watching needs no token at all.
 */
async function ensureToken(
  nation: number | null,
  name: string,
): Promise<string | null> {
  if (nation === null) return null;
  const held = heldToken();
  if (held !== null) return held;
  try {
    const response = await fetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // An empty name registers anonymously; the server stores its placeholder.
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return null;
    const made = (await response.json()) as { token?: string };
    if (typeof made.token !== "string") return null;
    try {
      localStorage.setItem(TOKEN_KEY, made.token);
    } catch {
      // Kept for this page's life only; the next load registers again.
    }
    return made.token;
  } catch {
    return null;
  }
}

/**
 * Build the renderer for the map the world named.
 *
 * The two hashes are checked here and nowhere else. Province ids never travel,
 * so a mismatch — this client on a stale provinces.bin out of its HTTP cache,
 * or on map.bin where the world read map4x.bin — has nothing on the wire to
 * disagree about and shows up only as quietly mis-coloured regions.
 */
/**
 * The rubber band a player drags to say where a fleet or a wing works.
 *
 * A plain positioned `div` over the canvas rather than anything in the
 * renderer: it exists for the half-second the gesture lasts, and a WebGL
 * pass for a dashed rectangle would be three hundred lines nobody can test
 * against a browser this project does not open in CI.
 */
function drawnBox(): HTMLElement {
  const box = document.createElement("div");
  box.className = "world-draw-box";
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:40;border:2px dashed " +
    "rgba(190,245,255,.95);background:rgba(190,245,255,.12);border-radius:2px;" +
    "display:none";
  document.body.append(box);
  return box;
}

/** Put the band where the drag currently is, in screen pixels. */
function paintBox(
  box: HTMLElement,
  area: { x0: number; y0: number; x1: number; y1: number },
  camera: CameraController,
): void {
  const a = camera.worldToScreen(area.x0, area.y0);
  const b = camera.worldToScreen(area.x1, area.y1);
  box.style.display = "block";
  box.style.left = `${Math.min(a.x, b.x)}px`;
  box.style.top = `${Math.min(a.y, b.y)}px`;
  box.style.width = `${Math.abs(b.x - a.x)}px`;
  box.style.height = `${Math.abs(b.y - a.y)}px`;
}

/**
 * Where to point the camera so a player can see their own country.
 *
 * The bounding box of everything the nation controls, framed with the same
 * padding `Camera.focusBBox` uses. Province centres rather than tiles: the
 * centres are in the artefact, a tile scan would be four megabytes of work for
 * a framing that does not need to be exact, and §8 keeps tiles out of anything
 * a player action touches anyway.
 */
function homeView(
  grid: ProvinceMap,
  controllers: number[],
  nation: number,
  canvas: HTMLCanvasElement,
): { x: number; y: number; zoom: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const province of grid.provinces) {
    if (controllers[province.id] !== nation) continue;
    minX = Math.min(minX, province.centre.x);
    minY = Math.min(minY, province.centre.y);
    maxX = Math.max(maxX, province.centre.x);
    maxY = Math.max(maxY, province.centre.y);
  }
  // A nation with nothing left is not a framing problem; leave the map alone.
  if (minX === Infinity) return null;

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const zoom = Math.min(canvas.width / width, canvas.height / height) / 1.4;
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom: Math.max(0.5, Math.min(8, zoom)),
  };
}

async function buildFrom(
  state: FullState,
  onProvince: (province: number) => void,
): Promise<{
  view: MapRenderer;
  adapter: FrameAdapter;
  provinces: ProvinceMap["provinces"];
  anchors: ZoneAnchors;
  camera: CameraController;
  grid: ProvinceMap;
  mapSize: { width: number; height: number };
}> {
  const map = await loadWorldMap(state.map.id);
  const grid = map.provinces;

  if (grid.terrainHash !== state.map.terrainHash) {
    throw new Error(
      `Map mismatch on ${state.map.id}: the world's terrain hash is ` +
        `${state.map.terrainHash.toString(16)}, this client loaded ` +
        `${grid.terrainHash.toString(16)}. Province ids would not line up.`,
    );
  }
  if (grid.partitionHash !== state.map.partitionHash) {
    throw new Error(
      `Province artefact mismatch on ${state.map.id}: the world is running ` +
        `${state.map.partitionHash.toString(16)}, this client loaded ` +
        `${grid.partitionHash.toString(16)}. Reload with the cache cleared.`,
    );
  }
  if (grid.provinceCount !== state.map.provinceCount) {
    throw new Error(
      `Province count mismatch: the world has ${state.map.provinceCount}, ` +
        `this client loaded ${grid.provinceCount}`,
    );
  }

  const index = new ProvinceTileIndex(grid);
  const adapter = new FrameAdapter(index, grid, state.nations.length);

  const canvas = createCanvas();
  const view = new MapRenderer(
    canvas,
    {
      mapWidth: map.width,
      mapHeight: map.height,
      unitTypes: [...ALL_UNIT_TYPES],
      // Has to be here at construction: NamePass and the territory pass read
      // the list from the header. addPlayers() is the other route and wants
      // 4 MB of pattern data phase 0 does not have.
      players: state.nations.map((n) => ({
        smallID: n.smallID,
        id: `nation-${n.smallID}`,
        name: n.name,
        displayName: n.name,
        clanTag: null,
        clientID: null,
        playerType: PlayerTypeEnum.Nation,
        team: null,
        isLobbyCreator: false,
        // Resolved once at construction; a deployment that does not serve
        // `resources/flags` gets no flag and no broken image.
        flag: n.flag === undefined ? undefined : `/flags/${n.flag}.svg`,
      })),
      maxPlayers: 256,
    },
    () => map.terrain,
    buildPalette(state.nations.length),
    rules,
    createRenderSettings(),
  );

  // After construction, so the renderer's own initial fit has happened and
  // the controller continues from it rather than pushing a competing framing.
  // **Start looking at the nation being played.** The renderer's own fit
  // frames the whole map, which for a continent means a player opens the game
  // pointed at nothing in particular and has to hunt for their own territory.
  // A spectator still gets the whole map, which is what a spectator wants.
  const own = state.economy?.nation ?? null;
  // Never set before, so `uLocalPlayerID` was 0 and the structure shader's
  // own-buildings outline was inert for every nation.
  if (own !== null) view.setLocalPlayerID(own);
  const home =
    own === null ? null : homeView(grid, state.controllers, own, canvas);
  const initialCamera = home ??
    view.getCameraState() ?? {
      x: map.width / 2,
      y: map.height / 2,
      zoom: 1,
    };
  if (home !== null) view.setCameraState(home.x, home.y, home.zoom);
  // Province borders as a map layer, drawn over the terrain and under the
  // territory. Awaited rather than fired off: the renderer keeps the bitmap,
  // and handing it one that is still decoding is a race with no error
  // message. It costs one decode of a full-map image at startup.
  // All layers in one call: `setMapLayers` replaces the set. The zone layers
  // start hidden — the map is full enough — and `z` shows them.
  const [borderImages, zoneImages] = await Promise.all([
    borderLayerImages(grid.borderTiles, map.width, map.height),
    zoneLayerImages(grid, map.width, map.height),
  ]);
  view.setMapLayers(
    [...PROVINCE_BORDER_LAYERS, ...ZONE_LAYERS],
    new Map([...borderImages, ...zoneImages]),
  );
  for (const layer of ZONE_LAYERS) view.setLayerVisible(layer.id, false);

  // A border overlay that cannot be turned off is a border overlay somebody
  // will ask to have removed. `b`, and nothing else — this is not a settings
  // screen, and phase 3 brings the HUD that would own one.
  let bordersVisible = true;
  let zonesVisible = false;
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "b") {
      bordersVisible = !bordersVisible;
      view.setLayerVisible(PROVINCE_BORDER_LAYER, bordersVisible);
    }
    // The air and sea zones the wings and fleets are sent to (§6.7, §6.8),
    // which had been numbers in a panel and nothing on the map.
    if (event.key === "z") {
      zonesVisible = !zonesVisible;
      for (const layer of ZONE_LAYERS) {
        view.setLayerVisible(layer.id, zonesVisible);
      }
    }
  });

  const camera = new CameraController(
    canvas,
    initialCamera,
    (x, y, z) => view.setCameraState(x, y, z),
    (worldX, worldY) => {
      // Tiles exist for rendering only and are never addressable by a player
      // action (CLAUDE.md §8). This is the one place the projection runs in
      // reverse, and it stops at the province.
      const tx = Math.floor(worldX);
      const ty = Math.floor(worldY);
      if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return;
      const province = grid.provinceOfTile[ty * map.width + tx];
      if (province >= 0) onProvince(province);
    },
  );

  return {
    view,
    adapter,
    provinces: grid.provinces,
    // One tile per zone, worked out once: where a wing or a fleet stands
    // when it is assigned to an area rather than to a place.
    anchors: zoneAnchors(grid, map.width),
    camera,
    grid,
    mapSize: { width: map.width, height: map.height },
  };
}

startWorldClient().catch((e: unknown) => {
  console.error("world client failed to start", e);
  showFatal(
    `The world failed to load: ${e instanceof Error ? e.message : String(e)}`,
  );
});
