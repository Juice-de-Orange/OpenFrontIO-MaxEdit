/**
 * What persistence has to provide, and nothing more.
 *
 * An interface rather than a Postgres client, for two reasons that are not
 * about testing. First, `npm run start:server` has to work with no database:
 * the client development loop is the thing that gets run twenty times an hour,
 * and making it depend on a container is how a project acquires a setup step
 * nobody remembers. Second, the restore logic is the part of phase 1 that must
 * be right, and it deserves to be exercised without a database in the way.
 *
 * The durable record of a world is exactly two things: an append-only command
 * log, and periodic snapshots. Everything else — the partition, the map, the
 * nation list — is derived from map data both sides already hold.
 */

import type { CommandBody } from "src/shared/protocol/Wire";
import type { WorldSnapshot } from "../world/World";

/**
 * One command as it was accepted.
 *
 * `tick` is the tick it takes effect on, and `seq` its position within that
 * tick. Two commands on one tick have to be replayed in the order they were
 * accepted, and nothing else records that order — the database's own id is an
 * insertion order, which is the same thing only until a write is retried.
 */
export interface StoredCommand {
  tick: number;
  seq: number;
  nation: number;
  body: CommandBody;
}

export interface StoredSnapshot {
  tick: number;
  /** World.stateHash() at the moment it was taken. Checked on load. */
  stateHash: number;
  state: WorldSnapshot;
}

export interface WorldStore {
  /**
   * Take the world's exclusive lock, or return false.
   *
   * Two processes ticking one world is the most expensive failure this
   * architecture has: both would write to the same command log, and the log
   * would then describe a run neither of them had.
   */
  acquireWorldLock(worldId: string): Promise<boolean>;

  /**
   * Record the world's identity, or check it against what is already there.
   *
   * Both hashes, because either can change without the other: new map bytes
   * with an old artefact, or a regenerated artefact over unchanged terrain.
   * The second is the one that has no other symptom.
   */
  ensureWorld(
    worldId: string,
    mapId: string,
    terrainHash: number,
    partitionHash: number,
  ): Promise<void>;

  latestSnapshot(worldId: string): Promise<StoredSnapshot | null>;

  /** Every command with tick > `tick`, in (tick, seq) order. */
  commandsAfter(worldId: string, tick: number): Promise<StoredCommand[]>;

  appendCommand(worldId: string, command: StoredCommand): Promise<void>;

  writeSnapshot(worldId: string, snapshot: StoredSnapshot): Promise<void>;

  close(): Promise<void>;
}
