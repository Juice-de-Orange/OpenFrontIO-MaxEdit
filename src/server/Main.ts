/**
 * The world server process.
 *
 * One process, one world. No cluster.fork(), no worker shards — upstream's
 * `simpleHash(gameID) % NUM_WORKERS` sharding is gone with the match server it
 * belonged to.
 *
 * This file is assembly only: load the map, take the world's lock, put the
 * world back where it was, open the socket, start the clock. The rules live in
 * World, the persistence in WorldRunner, the schedule in TickLoop.
 */

import path from "path";
import { fileURLToPath } from "url";
import { MemoryStore } from "./db/MemoryStore";
import { PgStore } from "./db/PgStore";
import type { WorldStore } from "./db/Store";
import { WorldSocketServer } from "./net/WsServer";
import { World } from "./world/World";
import { WorldRunner } from "./world/WorldRunner";

import { TICK_MS } from "src/shared/config/time";

const PORT = Number(process.env.PORT ?? 3000);
const WORLD_ID = process.env.WORLD_ID ?? "world-0";
const MAP_ID = process.env.MAP_ID ?? "europe";

/**
 * The tick interval, overridable for gates.
 *
 * A real world ticks every five seconds (`TICK_MS`), and nothing about the
 * simulation depends on that number — the schedule is anchored to the tick
 * (decision 0003) and every rate is per tick, so a faster clock runs the same
 * world sooner rather than a different world.
 *
 * It exists because the later gates are otherwise unrunnable. §8's phase-10
 * gate asks for 2,000 ticks under regent control; at five seconds that is two
 * hours and forty-seven minutes, and a gate nobody has time to run is a gate
 * nobody runs. Phase 3's asks to watch a factory finish, which is 200 ticks.
 *
 * A world running at anything but TICK_MS says so on every start, loudly,
 * because a production world that quietly ticks twenty times too fast would
 * burn a six-week season in three days.
 */
const TICK_INTERVAL_MS = tickInterval();

function tickInterval(): number {
  // Compose passes `WORLD_TICK_MS: ${WORLD_TICK_MS:-}`, which sets the
  // variable to the empty string when it is not supplied. `??` does not catch
  // that and `Number("")` is 0, which would give a world with no delay between
  // ticks at all.
  const raw = process.env.WORLD_TICK_MS;
  if (raw === undefined || raw.trim() === "") return TICK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `WORLD_TICK_MS=${raw} is not a positive number of milliseconds`,
    );
  }
  return parsed;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(here, "..", "..", "resources");

/**
 * A world with no database keeps its history in memory and loses it on exit.
 *
 * That is the right default for the client development loop, which is run
 * many times a day and should not need a container. It is emphatically not the
 * right default for anything else, so it says so.
 */
async function createStore(): Promise<WorldStore> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    console.warn(
      "[world] no DATABASE_URL: this world is not persisted and will be lost " +
        "when the process ends",
    );
    return new MemoryStore();
  }
  return PgStore.connect({
    connectionString: url,
    onLockLost: (error) => {
      // The lock is the only thing keeping a second process off this world.
      // Without it, carrying on is worse than stopping: two servers would
      // append to one command log and the log would describe neither run.
      console.error("[world] lost the world lock, stopping", error);
      process.exit(1);
    },
  });
}

async function main(): Promise<void> {
  // The world's seed comes from its name, so two seasons on the same map do
  // not roll the same battles (§9, and decision 0014).
  const world = await World.load(MAP_ID, RESOURCES, World.seedFor(WORLD_ID));
  console.info(
    `[world] ${WORLD_ID} on map ${MAP_ID}: ` +
      `${world.descriptor.width}x${world.descriptor.height}, ` +
      `${world.descriptor.provinceCount} provinces, ` +
      `${world.nations.length} nations, ` +
      `terrain ${world.descriptor.terrainHash.toString(16)}`,
  );

  const store = await createStore();
  if (!(await store.acquireWorldLock(WORLD_ID))) {
    console.error(
      `[world] ${WORLD_ID} is already being ticked by another process. ` +
        "Two processes on one world would both write to its command log, and " +
        "the log would then describe a run neither of them had.",
    );
    process.exit(1);
  }

  if (TICK_INTERVAL_MS !== TICK_MS) {
    console.warn(
      `[world] WORLD_TICK_MS=${TICK_INTERVAL_MS} overrides the ${TICK_MS} ms ` +
        `tick. This world runs ${(TICK_MS / TICK_INTERVAL_MS).toFixed(1)}x ` +
        `real time and is not a production world.`,
    );
  }

  const runner = new WorldRunner({
    world,
    store,
    worldId: WORLD_ID,
    tickMs: TICK_INTERVAL_MS,
  });
  const resumedAt = await runner.restore();
  console.info(`[world] resuming at tick ${resumedAt}`);

  const server = new WorldSocketServer(
    world,
    (nation, body) => runner.submit(nation, body),
    WORLD_ID,
    PORT,
    () => runner.status(),
  );
  runner.setOnChanges((tick, changes) => server.broadcastDelta(tick, changes));
  runner.start();
  console.info(
    `[world] listening on ws://localhost:${PORT}/ws, health on ` +
      `http://localhost:${PORT}/health`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[world] ${signal}, stopping at tick ${world.currentTick()}`);
    runner.stop();
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  console.error("[world] failed to start", e);
  process.exit(1);
});
