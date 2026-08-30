/**
 * The world server process.
 *
 * One process, one world. No cluster.fork(), no worker shards — upstream's
 * `simpleHash(gameID) % NUM_WORKERS` sharding is gone with the match server it
 * belonged to.
 *
 * Phase 0 keeps the loop as simple as it can be while still having the right
 * shape. Phase 1 replaces `setInterval` with a deadline computed from a fixed
 * epoch (setInterval accumulates drift and fires bursts when behind), awaits
 * the tick before starting the next, and adds the command log and snapshots
 * around it.
 */

import path from "path";
import { TICK_MS } from "src/shared/config/time";
import { fileURLToPath } from "url";
import { WorldSocketServer } from "./net/WsServer";
import { StubWorld } from "./world/StubWorld";

const PORT = Number(process.env.PORT ?? 3000);
const WORLD_ID = process.env.WORLD_ID ?? "world-0";
const MAP_ID = process.env.MAP_ID ?? "europe";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(here, "..", "..", "resources");

async function main(): Promise<void> {
  const world = await StubWorld.load(MAP_ID, RESOURCES);
  console.info(
    `[world] ${WORLD_ID} on map ${MAP_ID}: ` +
      `${world.descriptor.width}x${world.descriptor.height}, ` +
      `${world.descriptor.provinceCount} provinces, ` +
      `${world.nations.length} nations, ` +
      `terrain ${world.descriptor.terrainHash.toString(16)}`,
  );

  const server = new WorldSocketServer(world, WORLD_ID, PORT);
  console.info(`[world] listening on ws://localhost:${PORT}/ws`);

  const timer = setInterval(() => {
    const changes = world.step();
    server.broadcastDelta(world.currentTick(), changes);
  }, TICK_MS);

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[world] ${signal}, stopping at tick ${world.currentTick()}`);
    clearInterval(timer);
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  console.error("[world] failed to start", e);
  process.exit(1);
});
