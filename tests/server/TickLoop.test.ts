import { describe, expect, test } from "vitest";
import { TickLoop, type TickLoopTimers } from "../../src/server/world/TickLoop";

const TICK_MS = 5000;

/**
 * A clock the test drives by hand.
 *
 * Vitest's fake timers replace the global ones, which an awaited callback then
 * fights: the loop's `await onTick(...)` settles on the microtask queue, not on
 * a timer, so advancing fake time alone does not run it. Injecting the clock
 * keeps both explicit — time moves when the test says so, and `flush` drains
 * what the await left behind.
 */
class ManualTimers implements TickLoopTimers {
  time = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimer(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ at: this.time + ms, fn, id });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }

  /** Move time forward, running every timer that comes due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let due: { at: number; fn: () => void; id: number } | undefined;
      for (const t of this.queue) {
        if (t.at <= target && (due === undefined || t.at < due.at)) due = t;
      }
      if (due === undefined) break;
      this.queue = this.queue.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
      await flush();
    }
    this.time = target;
  }
}

/** Let every pending microtask and awaited promise settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("TickLoop", () => {
  test("runs one tick per tickMs, counting up from the start tick", async () => {
    const timers = new ManualTimers();
    const ticks: number[] = [];
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 0,
      timers,
      onTick: async (tick) => {
        ticks.push(tick);
      },
    });

    loop.start();
    await timers.advance(TICK_MS * 3);
    loop.stop();

    expect(ticks).toEqual([1, 2, 3]);
    expect(loop.currentTick()).toBe(3);
  });

  test("a late tick does not shift the next one", async () => {
    const timers = new ManualTimers();
    const startedAt: number[] = [];
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 0,
      timers,
      onTick: async (tick) => {
        startedAt.push(timers.now());
        // Tick 1 overruns by 300 ms. With setInterval the whole schedule would
        // move 300 ms later and stay there; with an absolute deadline it does
        // not.
        if (tick === 1) timers.time += 300;
      },
    });

    loop.start();
    await timers.advance(TICK_MS * 3);
    loop.stop();

    expect(startedAt).toEqual([5000, 10000, 15000]);
  });

  test("never runs two ticks at once, however long one takes", async () => {
    const timers = new ManualTimers();
    let inTick = false;
    let overlaps = 0;
    const ticks: number[] = [];
    // Tick 1 is held open until the test lets go of it. Nothing else may run
    // in the meantime — an unawaited tick would schedule the next one at once,
    // and the two would mutate world state concurrently.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 0,
      timers,
      onTick: async (tick) => {
        if (inTick) overlaps++;
        inTick = true;
        ticks.push(tick);
        if (tick === 1) await held;
        inTick = false;
      },
    });

    loop.start();
    await timers.advance(TICK_MS);
    expect(ticks).toEqual([1]);

    // Four ticks' worth of time passes while tick 1 is still running.
    await timers.advance(TICK_MS * 4);
    expect(overlaps).toBe(0);
    expect(ticks).toEqual([1]);

    release();
    await flush();
    await timers.advance(TICK_MS);
    loop.stop();

    // Once it is let go the loop catches up on the ticks that came due while
    // it was held — one after another, never two at a time.
    expect(overlaps).toBe(0);
    expect(ticks).toEqual(ticks.map((_, i) => i + 1));
    expect(ticks.length).toBeGreaterThan(1);
  });

  test("catches up after an overrun inside a run", async () => {
    const timers = new ManualTimers();
    const startedAt: number[] = [];
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 0,
      timers,
      onTick: async (tick) => {
        startedAt.push(timers.now());
        // Seven seconds: longer than the tick itself.
        if (tick === 1) timers.time += 7000;
      },
    });

    loop.start();
    await timers.advance(TICK_MS * 4);
    loop.stop();

    // Tick 1 ends at 12000, by which point tick 2 was already due at 10000, so
    // it starts at once. Catch-up within a run is intended; it is only downtime
    // that must never be re-simulated.
    expect(startedAt.slice(0, 3)).toEqual([5000, 12000, 15000]);
  });

  test("resuming at a tick does not re-simulate the downtime", async () => {
    // The world stopped at tick 500. Three hours of wall clock pass — 2,160
    // ticks' worth — and it starts again.
    const timers = new ManualTimers();
    timers.time = 3 * 60 * 60 * 1000;
    const ticks: number[] = [];
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 500,
      timers,
      onTick: async (tick) => {
        ticks.push(tick);
      },
    });

    loop.start();
    await timers.advance(TICK_MS * 2);
    loop.stop();

    expect(ticks).toEqual([501, 502]);
  });

  test("stop() keeps the next tick from running", async () => {
    const timers = new ManualTimers();
    const ticks: number[] = [];
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 0,
      timers,
      onTick: async (tick) => {
        ticks.push(tick);
      },
    });

    loop.start();
    await timers.advance(TICK_MS);
    loop.stop();
    await timers.advance(TICK_MS * 5);

    expect(ticks).toEqual([1]);
  });

  test("a failing tick is reported and the world keeps ticking", async () => {
    const timers = new ManualTimers();
    const failures: number[] = [];
    const ticks: number[] = [];
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 0,
      timers,
      onTick: async (tick) => {
        ticks.push(tick);
        if (tick === 2) throw new Error("snapshot write failed");
      },
      onError: (tick) => failures.push(tick),
    });

    loop.start();
    await timers.advance(TICK_MS * 3);
    loop.stop();

    expect(failures).toEqual([2]);
    expect(ticks).toEqual([1, 2, 3]);
  });

  test("lagMs reports how far behind the next deadline is", async () => {
    const timers = new ManualTimers();
    const loop = new TickLoop({
      tickMs: TICK_MS,
      startTick: 0,
      timers,
      onTick: async () => {},
    });

    loop.start();
    await timers.advance(TICK_MS);
    expect(loop.lagMs()).toBe(0);

    // The process is wedged: time moves, ticks do not.
    timers.time += TICK_MS * 4;
    expect(loop.lagMs()).toBe(TICK_MS * 3);
    loop.stop();
  });
});
