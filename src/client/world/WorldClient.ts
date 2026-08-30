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
import { computeProvinceGrid } from "src/shared/map/ProvinceGrid";
import { CameraController } from "./CameraController";
import { FrameAdapter } from "./FrameAdapter";
import { loadWorldMap } from "./MapAssets";
import { buildPalette } from "./Palette";
import { ProvinceTileIndex } from "./ProvinceTileIndex";
import { StaticWorldSource } from "./StaticWorldSource";

/** One in-game hour per tick, five seconds of wall clock. */
const TICK_MS = 5000;

/** Province grid cell size, in tiles. Phase 2 replaces the whole partition. */
const PROVINCE_CELL = 64;

const DEFAULT_MAP = "europe";

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
  mapId: string = DEFAULT_MAP,
): Promise<void> {
  // Both before the renderer is constructed, and awaited: NamePass and
  // StructureLevelPass parse the MSDF atlas in their constructors and throw
  // "Atlas data not loaded" if it has not arrived. Fetched in parallel with
  // the map because neither depends on the other.
  const [map] = await Promise.all([loadWorldMap(mapId), preloadAtlasData()]);

  const grid = computeProvinceGrid(
    map.terrain,
    map.width,
    map.height,
    PROVINCE_CELL,
  );
  if (grid.count === 0) {
    throw new Error(`Map ${mapId} has no land tiles`);
  }

  const index = new ProvinceTileIndex(grid);
  const adapter = new FrameAdapter(index, map.nations.length);
  const source = new StaticWorldSource(grid, map.nations, map.width);

  const canvas = createCanvas();
  const palette = buildPalette(map.nations.length);

  const view = new MapRenderer(
    canvas,
    {
      mapWidth: map.width,
      mapHeight: map.height,
      unitTypes: [...ALL_UNIT_TYPES],
      // The nation list has to be here at construction: NamePass and the
      // territory pass read it from the header. addPlayers() is the other
      // route and wants 4 MB of pattern data phase 0 does not have.
      players: map.nations.map((n, i) => ({
        smallID: i + 1,
        id: `nation-${i + 1}`,
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
    palette,
    rules,
    createRenderSettings(),
  );

  // After construction, so the renderer's initial fit has happened and the
  // controller can continue from it instead of pushing a competing framing.
  const initialCamera = view.getCameraState() ?? {
    x: map.width / 2,
    y: map.height / 2,
    zoom: 1,
  };
  const camera = new CameraController(canvas, initialCamera, (x, y, z) =>
    view.setCameraState(x, y, z),
  );
  void camera;

  const initial = source.fullState();
  adapter.applyFullState(initial.owners, initial.tick);
  uploadFrameData(view, adapter.frameData());

  window.setInterval(() => {
    const { tick, changes } = source.step();
    adapter.applyDelta(changes, tick);
    uploadFrameData(view, adapter.frameData());
  }, TICK_MS);
}

startWorldClient().catch((e: unknown) => {
  console.error("world client failed to start", e);
  showFatal(
    `The world failed to load: ${e instanceof Error ? e.message : String(e)}`,
  );
});
