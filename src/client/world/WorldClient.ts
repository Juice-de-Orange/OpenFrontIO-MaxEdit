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
import { computeProvincePartition } from "src/shared/map/ProvincePartition";
import { terrainHashFnv1a } from "src/shared/map/TerrainHash";
import type { FullState } from "src/shared/protocol/Wire";
import { CameraController } from "./CameraController";
import { FrameAdapter } from "./FrameAdapter";
import { loadWorldMap } from "./MapAssets";
import { buildPalette } from "./Palette";
import { ProvinceTileIndex } from "./ProvinceTileIndex";
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
  const pickProvince = (province: number): void => {
    if (nation === null) {
      showNotice("Watching only. Add ?nation=<n> to the URL to play one.");
      return;
    }
    const sent = socket.sendCommand({
      kind: "claim_province",
      provinceId: province,
    });
    if (sent === null) showNotice("Not connected to the world.");
  };

  const socket: WorldSocket = new WorldSocket(
    worldSocketUrl(),
    worldId,
    nation,
    {
      onFullState: (state) => {
        if (!view || !adapter) {
          // First full state carries the map identity, so the renderer cannot
          // be built before it arrives.
          void buildFrom(state, pickProvince).then((built) => {
            view = built.view;
            adapter = built.adapter;
            adapter.applyFullState(state.owners, state.tick);
            uploadFrameData(view, adapter.frameData());
          });
          return;
        }
        adapter.applyFullState(state.owners, state.tick);
        uploadFrameData(view, adapter.frameData());
      },
      onDelta: (delta) => {
        if (!view || !adapter) return; // full state still loading
        adapter.applyDelta(delta.changes, delta.tick);
        uploadFrameData(view, adapter.frameData());
      },
      onAck: (ack) => {
        showNotice(
          ack.accepted
            ? `Order accepted for tick ${ack.tick}.`
            : `Order refused: ${ack.reason}`,
        );
      },
      onFatal: (message) => showFatal(message),
    },
  );
}

/**
 * Build the renderer for the map the world named.
 *
 * The terrain hash is checked here and nowhere else. Province ids are derived
 * on both sides from the same bytes and never travel, so a mismatch — one
 * side on map.bin, the other on map4x.bin — has nothing on the wire to
 * disagree about and shows up only as quietly mis-coloured regions.
 */
async function buildFrom(
  state: FullState,
  onProvince: (province: number) => void,
): Promise<{ view: MapRenderer; adapter: FrameAdapter }> {
  const map = await loadWorldMap(state.map.id);

  if (terrainHashFnv1a(map.terrain) !== state.map.terrainHash) {
    throw new Error(
      `Map mismatch on ${state.map.id}: the world's terrain hash is ` +
        `${state.map.terrainHash.toString(16)}, this client computed ` +
        `${terrainHashFnv1a(map.terrain).toString(16)}. Province ids would not line up.`,
    );
  }

  // Derived, not received: the province -> tile mapping is static map data.
  // The server ran the same function over the same bytes, and the terrain
  // hash above is what proves the two agree.
  const grid = computeProvincePartition(
    map.terrain,
    map.width,
    map.height,
    map.nations.map((n) => ({ x: n.coordinates[0], y: n.coordinates[1] })),
  );
  if (grid.count !== state.map.provinceCount) {
    throw new Error(
      `Province count mismatch: the world has ${state.map.provinceCount}, ` +
        `this client derived ${grid.count}`,
    );
  }

  const index = new ProvinceTileIndex(grid);
  const adapter = new FrameAdapter(index, state.nations.length);

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
  const initialCamera = view.getCameraState() ?? {
    x: map.width / 2,
    y: map.height / 2,
    zoom: 1,
  };
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

  return { view, adapter };
}

startWorldClient().catch((e: unknown) => {
  console.error("world client failed to start", e);
  showFatal(
    `The world failed to load: ${e instanceof Error ? e.message : String(e)}`,
  );
});
