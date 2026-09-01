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
import type { ProvinceMap } from "src/shared/map/ProvinceMap";
import type { FullState } from "src/shared/protocol/Wire";
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
import { t } from "./ui/strings";
import { WorldSocket } from "./WorldSocket";

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

function showFatal(message: string): void {
  const box = document.createElement("div");
  box.id = "world-error";
  box.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
    "background:#1b1b1b;color:#eee;font:14px system-ui;padding:2rem;text-align:center;z-index:10";
  box.textContent = message;
  document.body.appendChild(box);
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

  const nation = nationFromUrl();

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
    cancelAttack: (province) =>
      send({ kind: "cancel_attack", provinceId: province }),
    navalInvade: (divisionId, province) =>
      send({ kind: "naval_invade", divisionId, provinceId: province }),
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
    disbandFormation: (formationId) =>
      send({ kind: "disband_formation", formationId }),
  });

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

        if (!view || !adapter) {
          // First full state carries the map identity, so the renderer cannot
          // be built before it arrives.
          void buildFrom(state, pickProvince).then((built) => {
            view = built.view;
            adapter = built.adapter;
            model.provinces = built.provinces;
            adapter.applyFullState(state.controllers, state.tick);
            adapter.applyFronts(state.fronts, model.controllers);
            uploadFrameData(view, adapter.frameData());
            hud.update(model);
          });
          return;
        }
        adapter.applyFullState(state.controllers, state.tick);
        adapter.applyFronts(state.fronts, model.controllers);
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

        if (!view || !adapter) return; // full state still loading
        // Control, not ownership: the map shows where the line is, not who
        // holds the title deeds (docs/decisions/0002).
        adapter.applyDelta(delta.control, delta.tick);
        // After the base ownership, so a repainted province gets its front
        // back — and a front that shrank or ended gets unwound.
        adapter.applyFronts(delta.fronts, model.controllers);
        uploadFrameData(view, adapter.frameData());
        hud.update(model);
      },
      onAck: (ack) => {
        showNotice(
          ack.accepted
            ? t("hud.orderAccepted", { tick: ack.tick ?? 0 })
            : t("hud.orderRefused", { reason: ack.reason ?? "" }),
        );
      },
      onFatal: (message) => showFatal(message),
    },
  );
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
  const zoom = Math.min(
    canvas.width / width,
    canvas.height / height,
  ) / 1.4;
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
  const home = own === null ? null : homeView(grid, state.controllers, own, canvas);
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
  view.setMapLayers(
    PROVINCE_BORDER_LAYERS,
    await borderLayerImages(grid.borderTiles, map.width, map.height),
  );

  // A border overlay that cannot be turned off is a border overlay somebody
  // will ask to have removed. `b`, and nothing else — this is not a settings
  // screen, and phase 3 brings the HUD that would own one.
  let bordersVisible = true;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "b" || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    bordersVisible = !bordersVisible;
    view.setLayerVisible(PROVINCE_BORDER_LAYER, bordersVisible);
  });

  new CameraController(
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

  return { view, adapter, provinces: grid.provinces };
}

startWorldClient().catch((e: unknown) => {
  console.error("world client failed to start", e);
  showFatal(
    `The world failed to load: ${e instanceof Error ? e.message : String(e)}`,
  );
});
