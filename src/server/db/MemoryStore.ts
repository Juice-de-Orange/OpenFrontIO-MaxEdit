/**
 * A world store that forgets everything when the process ends.
 *
 * Two uses, both real. It is what `npm run start:server` uses when no
 * DATABASE_URL is set, so the client development loop needs no container. And
 * it is what the restore tests run against, because the thing being tested
 * there is the replay, not Postgres.
 *
 * It is deliberately strict about the same things the real store is — a
 * duplicate (tick, seq) is an error here too — so a bug does not wait for the
 * integration test to show itself.
 */

import type { StoredCommand, StoredSnapshot, WorldStore } from "./Store";

export class MemoryStore implements WorldStore {
  private readonly locks = new Set<string>();
  private readonly commands = new Map<string, StoredCommand[]>();
  private readonly snapshots = new Map<string, StoredSnapshot[]>();
  private readonly worlds = new Map<
    string,
    { mapId: string; terrainHash: number; partitionHash: number }
  >();

  async acquireWorldLock(worldId: string): Promise<boolean> {
    if (this.locks.has(worldId)) return false;
    this.locks.add(worldId);
    return true;
  }

  async ensureWorld(
    worldId: string,
    mapId: string,
    terrainHash: number,
    partitionHash: number,
  ): Promise<void> {
    const known = this.worlds.get(worldId);
    if (known === undefined) {
      this.worlds.set(worldId, { mapId, terrainHash, partitionHash });
      return;
    }
    if (known.partitionHash !== partitionHash) {
      throw new Error(
        `world ${worldId} was created on province artefact ` +
          `${known.partitionHash.toString(16)}, not ` +
          `${partitionHash.toString(16)}`,
      );
    }
    if (known.mapId !== mapId || known.terrainHash !== terrainHash) {
      throw new Error(
        `world ${worldId} was created on map ${known.mapId} ` +
          `(terrain ${known.terrainHash.toString(16)}), not ${mapId} ` +
          `(terrain ${terrainHash.toString(16)})`,
      );
    }
  }

  async latestSnapshot(worldId: string): Promise<StoredSnapshot | null> {
    const list = this.snapshots.get(worldId);
    if (list === undefined || list.length === 0) return null;
    let newest = list[0];
    for (const snapshot of list)
      if (snapshot.tick > newest.tick) newest = snapshot;
    return structuredClone(newest);
  }

  async commandsAfter(worldId: string, tick: number): Promise<StoredCommand[]> {
    const list = this.commands.get(worldId) ?? [];
    return structuredClone(
      list
        .filter((c) => c.tick > tick)
        .sort((a, b) => a.tick - b.tick || a.seq - b.seq),
    );
  }

  async appendCommand(worldId: string, command: StoredCommand): Promise<void> {
    const list = this.commands.get(worldId) ?? [];
    if (list.some((c) => c.tick === command.tick && c.seq === command.seq)) {
      throw new Error(
        `command already logged at tick ${command.tick} seq ${command.seq}`,
      );
    }
    list.push(structuredClone(command));
    this.commands.set(worldId, list);
  }

  async writeSnapshot(
    worldId: string,
    snapshot: StoredSnapshot,
  ): Promise<void> {
    const list = this.snapshots.get(worldId) ?? [];
    list.push(structuredClone(snapshot));
    this.snapshots.set(worldId, list);
  }

  async close(): Promise<void> {
    this.locks.clear();
  }
}
