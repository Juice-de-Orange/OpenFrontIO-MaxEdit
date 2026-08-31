/**
 * The world, its clock and its durable record, joined up.
 *
 * Everything in here exists to make one sentence true: **what the world did,
 * the log can do again.** Three rules follow from it, and each of them is a
 * decision rather than an implementation detail.
 *
 * **A command is written before it is queued.** If the log write fails, the
 * command is refused. A command the world accepted but did not record is a
 * command that vanishes at the next restart, and the player would have been
 * told it was accepted.
 *
 * **Ticks and command submissions are serialised against each other.** Both
 * are async — one awaits a snapshot write, the other a log write — and both
 * decide things based on the current tick. Interleaved, a command could be
 * logged for tick n and queued for tick n+1, which is a corruption no later
 * check would notice. One chain, no overlap.
 *
 * **Restore replays ticks, not just commands.** The world moves on its own
 * between commands, so replacing "run the world forward" with "apply the
 * commands" would land somewhere else entirely. Replay runs step() for every
 * tick after the snapshot and feeds each command in on its own tick.
 *
 * What the restore does *not* do is catch up on wall-clock time. A world
 * resumes at the last tick it has a durable record of — the newest snapshot,
 * or the last logged command if that is later — and time starts again from
 * there (docs/decisions/0003-tick-anchored-time.md). Up to one snapshot
 * interval of drift is therefore lost on a hard crash, and no player command
 * is. That is the trade CLAUDE.md §4 states, in code.
 */

import { SNAPSHOT_INTERVAL_TICKS, TICK_MS } from "src/shared/config/time";
import type { CommandBody } from "src/shared/protocol/Wire";
import type { WorldStore } from "../db/Store";
import type { CommandResult } from "../net/WsServer";
import { TickLoop } from "./TickLoop";
import type { World, WorldChanges } from "./World";

export interface WorldRunnerOptions {
  world: World;
  store: WorldStore;
  worldId: string;
  /** Called after every tick with what changed. */
  onChanges?: (tick: number, changes: WorldChanges) => void;
  snapshotEvery?: number;
  tickMs?: number;
}

export class WorldRunner {
  private readonly world: World;
  private readonly store: WorldStore;
  private readonly worldId: string;
  private readonly snapshotEvery: number;
  private readonly tickMs: number;
  private onChanges: (tick: number, changes: WorldChanges) => void;

  private loop: TickLoop | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSnapshotTick = 0;
  private snapshotFailures = 0;

  constructor(options: WorldRunnerOptions) {
    this.world = options.world;
    this.store = options.store;
    this.worldId = options.worldId;
    this.snapshotEvery = options.snapshotEvery ?? SNAPSHOT_INTERVAL_TICKS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.onChanges = options.onChanges ?? ((): void => {});
  }

  setOnChanges(fn: (tick: number, changes: WorldChanges) => void): void {
    this.onChanges = fn;
  }

  /**
   * Put the world back where it was, and report the tick it resumes at.
   *
   * Safe to call on a store that has never seen this world: it then does
   * nothing and the world stays at tick 0.
   */
  async restore(): Promise<number> {
    await this.store.ensureWorld(
      this.worldId,
      this.world.descriptor.id,
      this.world.descriptor.terrainHash,
      this.world.descriptor.partitionHash,
    );

    const snapshot = await this.store.latestSnapshot(this.worldId);
    if (snapshot !== null) {
      this.world.restoreFrom(snapshot.state);
      if (this.world.stateHash() !== snapshot.stateHash) {
        // **Usually the code, not the data.** `stateHash` mixes every field
        // the simulation owns, so adding one to the world changes what every
        // existing snapshot hashes to — and the honest reading of a mismatch
        // is "this world was written by a different build", not "your
        // database is corrupt". Saying the second sent someone looking at
        // Postgres for an afternoon. There is no migration for it: a world
        // whose state shape changed under it is started fresh.
        throw new Error(
          `snapshot at tick ${snapshot.tick} hashes to ` +
            `${snapshot.stateHash.toString(16)} but this build computes ` +
            `${this.world.stateHash().toString(16)}. Either the world state ` +
            `gained a field since it was written — in which case this world ` +
            `cannot be resumed by this build and needs to be started fresh ` +
            `(docker compose down -v) — or the stored state really is damaged.`,
        );
      }
      this.lastSnapshotTick = snapshot.tick;
    }

    const from = this.world.currentTick();
    const commands = await this.store.commandsAfter(this.worldId, from);
    if (commands.length === 0) return from;

    const until = commands[commands.length - 1].tick;
    let next = 0;
    for (let tick = from + 1; tick <= until; tick++) {
      while (next < commands.length && commands[next].tick === tick) {
        const command = commands[next++];
        this.world.enqueueAt(tick, {
          nation: command.nation,
          body: command.body,
        });
      }
      this.world.step();
    }
    if (next !== commands.length) {
      throw new Error(
        `replay consumed ${next} of ${commands.length} commands; the log is ` +
          `not ordered by tick`,
      );
    }
    return this.world.currentTick();
  }

  start(): void {
    if (this.loop !== undefined) throw new Error("runner already started");
    this.loop = new TickLoop({
      tickMs: this.tickMs,
      startTick: this.world.currentTick(),
      onTick: () => this.tickOnce(),
      onError: (tick, error) => {
        console.error(`[world] tick ${tick} failed`, error);
      },
    });
    this.loop.start();
  }

  stop(): void {
    this.loop?.stop();
    this.loop = undefined;
  }

  /** Run exactly one tick. Public so tests can drive a world without a clock. */
  async tickOnce(): Promise<void> {
    return this.serialise(async () => {
      const changes = this.world.step();
      const tick = this.world.currentTick();
      this.onChanges(tick, changes);
      if (tick % this.snapshotEvery === 0) await this.takeSnapshot();
    });
  }

  /**
   * Validate a command, record it, and queue it for the next tick — in that
   * order, and without a tick in between.
   */
  async submit(nation: number, body: CommandBody): Promise<CommandResult> {
    return this.serialise(async () => {
      const command = { nation, body };
      const rejection = this.world.rejectionFor(command);
      if (rejection !== null) return { accepted: false, reason: rejection };

      // Where it *will* land. Nothing can move the world in between: this runs
      // inside the same chain the tick does.
      const at = this.world.peekNextSlot();
      await this.store.appendCommand(this.worldId, {
        tick: at.tick,
        seq: at.seq,
        nation,
        body,
      });
      const queued = this.world.queueCommand(command);
      if (queued.tick !== at.tick || queued.seq !== at.seq) {
        throw new Error(
          `logged a command for tick ${at.tick} seq ${at.seq} but queued it ` +
            `at tick ${queued.tick} seq ${queued.seq}`,
        );
      }
      return { accepted: true, tick: queued.tick };
    });
  }

  private async takeSnapshot(): Promise<void> {
    const state = this.world.snapshot();
    try {
      await this.store.writeSnapshot(this.worldId, {
        tick: state.tick,
        stateHash: this.world.stateHash(),
        state,
      });
      this.lastSnapshotTick = state.tick;
      this.snapshotFailures = 0;
    } catch (e) {
      // The world keeps running. It is now further from its last durable
      // record than it should be, which is what the health endpoint reports.
      this.snapshotFailures++;
      console.error(
        `[world] snapshot at tick ${state.tick} failed ` +
          `(${this.snapshotFailures} in a row)`,
        e,
      );
    }
  }

  /** Serialise every mutation of the world onto one chain. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => undefined);
    return result;
  }

  status(): {
    tick: number;
    tickMs: number;
    lagMs: number;
    lastSnapshotTick: number;
    snapshotFailures: number;
    stateHash: number;
  } {
    return {
      tick: this.world.currentTick(),
      tickMs: this.tickMs,
      lagMs: this.loop?.lagMs() ?? 0,
      lastSnapshotTick: this.lastSnapshotTick,
      snapshotFailures: this.snapshotFailures,
      stateHash: this.world.stateHash(),
    };
  }
}
