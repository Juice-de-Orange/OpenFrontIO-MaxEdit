/**
 * The world's durable record, in Postgres.
 *
 * Two things here are load-bearing and neither is obvious from the queries.
 *
 * **The advisory lock is held on its own connection.** A session-level lock
 * lives and dies with the session that took it, so taking it on a pooled
 * connection means the lock's lifetime is whatever the pool decides — and a
 * pool is entitled to close an idle connection. This store keeps one client
 * outside the pool for the life of the process, does nothing else with it, and
 * reports if it ever drops. Two containers ticking one world would both append
 * to its command log, and the log would then describe a run neither of them
 * had; there is no repair for that afterwards.
 *
 * **Snapshots are bytes, not jsonb.** Nothing ever queries inside a snapshot,
 * so parsing and re-serialising a few hundred kilobytes on every read and
 * write buys nothing. Gzipped JSON in a bytea column.
 */

import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { gunzipSync, gzipSync } from "node:zlib";
import pg from "pg";
import type { WorldSnapshot } from "../world/World";
import { commands, snapshots, worlds } from "./schema";
import type { StoredCommand, StoredSnapshot, WorldStore } from "./Store";

export interface PgStoreOptions {
  connectionString: string;
  migrationsFolder?: string;
  /**
   * Called if the lock connection dies. The world is then no longer protected
   * from a second process, so the only safe response is to stop.
   */
  onLockLost?: (error: Error) => void;
}

export class PgStore implements WorldStore {
  private readonly pool: pg.Pool;
  private readonly db: NodePgDatabase;
  private lockClient: pg.Client | undefined;

  private constructor(
    pool: pg.Pool,
    private readonly options: PgStoreOptions,
  ) {
    this.pool = pool;
    this.db = drizzle(pool);
  }

  /** Connect and bring the schema up to date. */
  static async connect(options: PgStoreOptions): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: options.connectionString });
    const store = new PgStore(pool, options);
    await migrate(store.db, {
      migrationsFolder: options.migrationsFolder ?? "drizzle",
    });
    return store;
  }

  async acquireWorldLock(worldId: string): Promise<boolean> {
    if (this.lockClient !== undefined) {
      throw new Error("this store already holds a world lock");
    }
    const client = new pg.Client({
      connectionString: this.options.connectionString,
    });
    await client.connect();
    // A connection whose only job is to hold the lock will not be asked to do
    // anything else, so an error on it means exactly one thing: the lock is
    // gone.
    client.on("error", (error: Error) => {
      this.options.onLockLost?.(error);
    });

    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [worldId],
    );
    if (result.rows[0]?.locked !== true) {
      await client.end();
      return false;
    }
    this.lockClient = client;
    return true;
  }

  async ensureWorld(
    worldId: string,
    mapId: string,
    terrainHash: number,
    partitionHash: number,
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(worlds)
      .where(eq(worlds.id, worldId));

    if (existing.length === 0) {
      await this.db
        .insert(worlds)
        .values({ id: worldId, mapId, terrainHash, partitionHash });
      return;
    }

    const world = existing[0];
    if (world.mapId !== mapId || world.terrainHash !== terrainHash) {
      throw new Error(
        `world ${worldId} was created on map ${world.mapId} ` +
          `(terrain ${world.terrainHash.toString(16)}), not ${mapId} ` +
          `(terrain ${terrainHash.toString(16)}). Its province ids would mean ` +
          "different places.",
      );
    }

    if (world.partitionHash === null) {
      // A world from before this column existed. Adopt what it is running on
      // now rather than refusing to start it — there is nothing to compare
      // against, and refusing would strand a season on an old build.
      await this.db
        .update(worlds)
        .set({ partitionHash })
        .where(eq(worlds.id, worldId));
      return;
    }

    if (world.partitionHash !== partitionHash) {
      throw new Error(
        `world ${worldId} was created on province artefact ` +
          `${world.partitionHash.toString(16)}, not ` +
          `${partitionHash.toString(16)}. The terrain is unchanged, so nothing ` +
          "else would have noticed — but every province id in its command log " +
          "would mean a different place. Restore the artefact, or start a new " +
          "world (docs/decisions/0006).",
      );
    }
  }

  async latestSnapshot(worldId: string): Promise<StoredSnapshot | null> {
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.worldId, worldId))
      .orderBy(asc(snapshots.tick));
    if (rows.length === 0) return null;

    const newest = rows[rows.length - 1];
    return {
      tick: newest.tick,
      stateHash: newest.stateHash,
      state: JSON.parse(
        gunzipSync(newest.state).toString("utf-8"),
      ) as WorldSnapshot,
    };
  }

  async commandsAfter(worldId: string, tick: number): Promise<StoredCommand[]> {
    const rows = await this.db
      .select()
      .from(commands)
      .where(and(eq(commands.worldId, worldId), gt(commands.tick, tick)))
      .orderBy(asc(commands.tick), asc(commands.seq));

    return rows.map((row) => ({
      tick: row.tick,
      seq: row.seq,
      nation: row.nationId,
      // The payload is written by this server from an already-validated
      // command, so it is not re-parsed here. If it were ever wrong, the world
      // would refuse it on the tick it applies, exactly as it refuses a stale
      // one.
      body: row.payload as StoredCommand["body"],
    }));
  }

  async appendCommand(worldId: string, command: StoredCommand): Promise<void> {
    await this.db.insert(commands).values({
      worldId,
      tick: command.tick,
      seq: command.seq,
      nationId: command.nation,
      kind: command.body.kind,
      payload: command.body,
    });
  }

  async writeSnapshot(
    worldId: string,
    snapshot: StoredSnapshot,
  ): Promise<void> {
    await this.db
      .insert(snapshots)
      .values({
        worldId,
        tick: snapshot.tick,
        stateHash: snapshot.stateHash,
        state: gzipSync(Buffer.from(JSON.stringify(snapshot.state), "utf-8")),
      })
      .onConflictDoNothing();
  }

  async close(): Promise<void> {
    const client = this.lockClient;
    this.lockClient = undefined;
    if (client !== undefined) {
      // Removing the handler first: ending the connection on purpose is not
      // losing the lock, and reporting it as such would fire the shutdown path
      // during a shutdown.
      client.removeAllListeners("error");
      client.on("error", () => {});
      await client.end();
    }
    await this.pool.end();
  }
}
