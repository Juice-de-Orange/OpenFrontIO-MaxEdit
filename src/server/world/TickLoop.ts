/**
 * The world's clock.
 *
 * Three properties, each of which was a bug in the phase-0 `setInterval`:
 *
 * **Deadlines are absolute.** Tick n is due at `epoch + n * tickMs`. A tick
 * that fires 300 ms late does not shift the next one, so error cannot
 * accumulate over a season. `setInterval` measures from when it last fired and
 * drifts by exactly the amount it was delayed, every time.
 *
 * **A tick is awaited before the next is scheduled.** Two overlapping ticks
 * would mutate world state concurrently, and there is no lock that would make
 * that safe. Once persistence is in the tick — a snapshot write is I/O —
 * overlap stops being theoretical.
 *
 * **The epoch is derived from the tick the world starts at**, not from a fixed
 * world beginning: `epoch = now - startTick * tickMs`. That is what makes
 * re-simulating downtime structurally impossible rather than bounded by a
 * limit somebody has to tune. See docs/decisions/0003-tick-anchored-time.md.
 *
 * Catch-up therefore only ever covers overload *within* a run: if a tick takes
 * longer than tickMs, the next one is already due and starts immediately.
 *
 * `now` and the timer are injectable so tests can drive the loop without real
 * time. Vitest's fake timers do not compose well with an awaited callback.
 */

export interface TickLoopTimers {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realTimers: TickLoopTimers = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface TickLoopOptions {
  tickMs: number;
  /** The tick the world resumes at. The first tick run is this plus one. */
  startTick: number;
  onTick(tick: number): Promise<void>;
  /**
   * Called when onTick throws. The loop keeps running: a failed snapshot write
   * must not stop a world. Call stop() from here if the failure is fatal.
   */
  onError?(tick: number, error: unknown): void;
  timers?: TickLoopTimers;
}

export class TickLoop {
  private readonly timers: TickLoopTimers;
  private tick: number;
  private epoch = 0;
  private handle: unknown;
  private running = false;
  private lastTickAt = 0;

  constructor(private readonly options: TickLoopOptions) {
    this.timers = options.timers ?? realTimers;
    this.tick = options.startTick;
  }

  start(): void {
    if (this.running) throw new Error("TickLoop already started");
    this.running = true;
    this.epoch = this.timers.now() - this.tick * this.options.tickMs;
    this.lastTickAt = this.timers.now();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) {
      this.timers.clearTimer(this.handle);
      this.handle = undefined;
    }
  }

  currentTick(): number {
    return this.tick;
  }

  /** When tick n was, or is, due. */
  deadlineOf(tick: number): number {
    return this.epoch + tick * this.options.tickMs;
  }

  /**
   * How far behind schedule the loop is, in milliseconds.
   *
   * Zero while it keeps up. A world that is up and *stuck* is the failure a
   * status code cannot see, so the health endpoint reports this rather than
   * just answering.
   */
  lagMs(): number {
    if (!this.running) return 0;
    return Math.max(0, this.timers.now() - this.deadlineOf(this.tick + 1));
  }

  /** Wall clock of the last completed tick. Not simulation input. */
  lastTickCompletedAt(): number {
    return this.lastTickAt;
  }

  private schedule(): void {
    const delay = Math.max(
      0,
      this.deadlineOf(this.tick + 1) - this.timers.now(),
    );
    this.handle = this.timers.setTimer(() => void this.runTick(), delay);
  }

  private async runTick(): Promise<void> {
    this.handle = undefined;
    if (!this.running) return;
    this.tick++;
    try {
      await this.options.onTick(this.tick);
    } catch (e) {
      this.options.onError?.(this.tick, e);
    }
    this.lastTickAt = this.timers.now();
    // Scheduled only after the tick has finished, so two ticks can never run
    // at once however long one of them takes.
    if (this.running) this.schedule();
  }
}
