/**
 * The world server process.
 *
 * One process, one world. No cluster.fork(), no worker shards — upstream's
 * `simpleHash(gameID) % NUM_WORKERS` sharding is gone with the match server it
 * belonged to.
 *
 * The loop itself is in TickLoop: deadlines are absolute, a tick is awaited
 * before the next is scheduled, and the epoch is derived from the tick the
 * world resumes at so downtime is never re-simulated.
 */

import path from "path";
import { TICK_MS } from "src/shared/config/time";
import { fileURLToPath } from "url";
import { WorldSocketServer, type CommandResult } from "./net/WsServer";
import { TickLoop } from "./world/TickLoop";
import { World } from "./world/World";

const PORT = Number(process.env.PORT ?? 3000);
const WORLD_ID = process.env.WORLD_ID ?? "world-0";
const MAP_ID = process.env.MAP_ID ?? "europe";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(here, "..", "..", "resources");

async function main(): Promise<void> {
  const world = await World.load(MAP_ID, RESOURCES);
  console.info(
    `[world] ${WORLD_ID} on map ${MAP_ID}: ` +
      `${world.descriptor.width}x${world.descriptor.height}, ` +
      `${world.descriptor.provinceCount} provinces, ` +
      `${world.nations.length} nations, ` +
      `terrain ${world.descriptor.terrainHash.toString(16)}`,
  );

  // Phase 1 accepts a command straight into the world. The next commit puts
  // the log write in front of it, which is where this function earns its
  // keep: nothing may be queued that has not been recorded first.
  const submit = async (
    nation: number,
    body: Parameters<typeof world.rejectionFor>[0]["body"],
  ): Promise<CommandResult> => {
    const command = { nation, body };
    const rejection = world.rejectionFor(command);
    if (rejection !== null) return { accepted: false, reason: rejection };
    const { tick } = world.queueCommand(command);
    return { accepted: true, tick };
  };

  const server = new WorldSocketServer(world, submit, WORLD_ID, PORT);
  console.info(`[world] listening on ws://localhost:${PORT}/ws`);

  const loop = new TickLoop({
    tickMs: TICK_MS,
    startTick: world.currentTick(),
    onTick: async (tick) => {
      const changes = world.step();
      // Two clocks that can disagree are two clocks too many. If they ever do,
      // the world's tick and the log's tick mean different things, and every
      // replay after this point is wrong in a way nothing would report.
      if (world.currentTick() !== tick) {
        throw new Error(
          `tick mismatch: loop at ${tick}, world at ${world.currentTick()}`,
        );
      }
      server.broadcastDelta(tick, changes);
    },
    onError: (tick, error) => {
      console.error(`[world] tick ${tick} failed`, error);
    },
  });
  loop.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[world] ${signal}, stopping at tick ${world.currentTick()}`);
    loop.stop();
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
