/**
 * The phase-1 gate, run rather than described.
 *
 * "Kill the server container mid-run; it resumes at the correct tick with no
 * lost commands." This does exactly that against `docker compose`, and checks
 * the two halves separately:
 *
 * - **No lost commands.** A claim is made *after* the newest snapshot, so it
 *   exists only in the command log. The world must come back holding it.
 * - **The correct tick.** The world must resume at the last tick it has a
 *   durable record of — the later of the newest snapshot and the newest
 *   logged command (decision 0005) — not at zero and not at the wall clock.
 *
 * The strong check is neither of those on its own. Before the kill this client
 * tracks province ownership from the full state and the deltas, and hashes it
 * per tick with the same function the server uses. After the restart the world
 * replays from the resume tick and passes back through ticks this client
 * already saw. Those hashes have to match. A restore that produced a plausible
 * world rather than *the* world would pass every other check here and fail
 * this one.
 *
 *   docker compose up -d
 *   node scripts/phase1-gate.mjs
 *
 * It takes a few minutes: it waits for a real snapshot rather than shortening
 * the interval, because a gate that runs against a special configuration
 * proves something about the special configuration.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";

const run = promisify(execFile);

const WORLD_ID = process.env.WORLD_ID ?? "world-0";
/**
 * Which nation the gate plays.
 *
 * Picked from the world rather than hardcoded. The border drift redraws the
 * map over hundreds of ticks and a nation can be wiped out entirely; a gate
 * that always asks for nation 1 eventually reports "could not claim anything"
 * on a perfectly healthy world, which is a false failure and a slow one to
 * read.
 */
let NATION = Number(process.env.GATE_NATION ?? 0);
const BASE = process.env.GATE_BASE ?? "http://localhost:3000";
const WS_URL = process.env.GATE_WS ?? "ws://localhost:3000/ws";
/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 *
 * This file is .mjs and cannot import it. Left behind at 2 when the wire moved
 * to 3, the gate stopped at "the world refused the connection" — which is the
 * gate failing rather than the world, and the worst way for a gate to fail.
 * `tests/GateProtocolVersion.test.ts` now reads this line and compares it.
 */
const PROTOCOL_VERSION = 20;
/** How long to wait for the snapshot the gate needs. Six minutes of ticks. */
const SNAPSHOT_TIMEOUT_MS = 8 * 60 * 1000;

const log = (...parts) => console.log(...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * FNV-1a over everything this client can see of the world.
 *
 * Not the server's `World.stateHash`: that also mixes `heldSince`, which
 * never goes on the wire. This hash exists to compare *this client's own view*
 * of a tick before and after the restart, and for that it has to be built only
 * from what the wire carries — which is also what makes it a check on the
 * deltas rather than on the server agreeing with itself.
 */
function viewHash(tick, owners, controllers) {
  let hash = 0x811c9dc5;
  const mix = (value) => {
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (value >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  };
  mix(tick);
  for (const owner of owners) mix(owner);
  for (const controller of controllers) mix(controller);
  return hash >>> 0;
}

async function health() {
  const response = await fetch(`${BASE}/health`);
  return { status: response.status, body: await response.json() };
}

async function waitForHealth(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { body } = await health();
      return body;
    } catch {
      if (Date.now() > until) throw new Error("the world never came up");
      await sleep(500);
    }
  }
}

/**
 * A connection that keeps its own copy of the world.
 *
 * Deliberately the same way the real client does it — full state once, deltas
 * after — because that is also what proves the deltas are complete.
 */
class Watcher {
  constructor(nation = NATION) {
    this.nation = nation;
    this.owners = null;
    this.controllers = null;
    this.tick = null;
    this.hashes = new Map();
    this.acks = new Map();
    this.ready = new Promise((resolve) => {
      this.onReady = resolve;
    });
    this.socket = new WebSocket(WS_URL);
    this.socket.on("open", () =>
      this.socket.send(
        JSON.stringify({
          t: "hello",
          protocolVersion: PROTOCOL_VERSION,
          worldId: WORLD_ID,
          nation: this.nation,
          token: this.token ?? null,
        }),
      ),
    );
    this.socket.on("message", (raw) =>
      this.onMessage(JSON.parse(raw.toString())),
    );
    // A refused connection is expected: `whenUp` knocks on a door that is not
    // open yet. An unhandled 'error' event would take the process down.
    this.socket.on("error", () => {});
  }

  onMessage(message) {
    switch (message.t) {
      case "full":
        this.owners = message.owners;
        this.controllers = message.controllers;
        this.tick = message.tick;
        this.hashes.set(
          message.tick,
          viewHash(message.tick, this.owners, this.controllers),
        );
        this.onReady();
        break;
      case "delta":
        for (const [province, nation] of message.control) {
          this.controllers[province] = nation;
        }
        for (const [province, nation] of message.owner) {
          this.owners[province] = nation;
        }
        this.tick = message.tick;
        this.hashes.set(
          message.tick,
          viewHash(message.tick, this.owners, this.controllers),
        );
        break;
      case "ack": {
        const waiting = this.acks.get(message.id);
        if (waiting) {
          this.acks.delete(message.id);
          waiting(message);
        }
        break;
      }
      case "reject":
        throw new Error(`the world refused the connection: ${message.detail}`);
    }
  }

  /** Send a claim and wait for its answer. */
  claim(provinceId, id) {
    const answered = new Promise((resolve) => this.acks.set(id, resolve));
    this.socket.send(
      JSON.stringify({
        t: "command",
        id,
        command: { kind: "claim_province", provinceId },
      }),
    );
    return answered;
  }

  /** Wait until the world has passed this tick. */
  async reaches(tick, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    while (this.tick < tick) {
      if (Date.now() > until)
        throw new Error(`the world never reached tick ${tick}`);
      await sleep(250);
    }
  }

  /**
   * A watcher that keeps knocking until the world opens the socket.
   *
   * The replay check needs a client attached the *instant* the world is back,
   * not half a second later: the restored world resumes at its last durable
   * record and starts ticking immediately, and every tick it passes before
   * this connects is a tick that cannot be compared with what was seen live.
   * Waiting for `/health` first, as this gate used to, cost ten of them at
   * fifty milliseconds a tick — and the symptom was the gate reporting that
   * nothing had been replayed.
   */
  static async whenUp(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const watcher = new Watcher();
      const opened = await Promise.race([
        watcher.ready.then(() => true),
        sleep(400).then(() => false),
      ]);
      if (opened) return watcher;
      watcher.socket.terminate();
      if (Date.now() > deadline) throw new Error("the world never came back");
      await sleep(50);
    }
  }

  close() {
    this.socket.close();
  }
}

/**
 * A province this nation can legally claim.
 *
 * The gate does not derive the province graph — it does not need to. Any
 * province held by somebody else is a candidate, and the world's own answer
 * says whether it borders us. Asking is cheaper than reimplementing the
 * partition, and it exercises the rejection path on the way.
 */
/** The nation holding the most provinces right now. */
function largestNation(controllers) {
  const held = new Map();
  for (const controller of controllers) {
    if (controller === 0) continue;
    held.set(controller, (held.get(controller) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [nation, count] of held) {
    if (count > bestCount) {
      best = nation;
      bestCount = count;
    }
  }
  return { nation: best, provinces: bestCount };
}

async function claimSomething(watcher, idPrefix) {
  let attempt = 0;
  let refused = 0;
  for (let province = 0; province < watcher.controllers.length; province++) {
    const holder = watcher.controllers[province];
    if (holder === watcher.nation || holder === 0) continue;
    const ack = await watcher.claim(province, `${idPrefix}-${attempt++}`);
    if (ack.accepted) return { province, tick: ack.tick, refused };
    refused++;
  }
  throw new Error(
    `nation ${watcher.nation} could not claim anything ` +
      `(${refused} provinces refused)`,
  );
}

/**
 * `docker compose`, with this world's clock carried through.
 *
 * The compose file reads `WORLD_TICK_MS` from the environment, so bringing the
 * world back up from here without it would silently return it to five seconds
 * a tick — and every gate that runs after this one would then refuse to start,
 * or worse, wait on an in-game day that had become a real one.
 */
/** What this world is actually ticking at, read from /health on the way in. */
let TICK_MS = 5000;

/** SNAPSHOT_INTERVAL_TICKS in shared/config/time.ts. */
const SNAPSHOT_TICKS = 60;

/** Ticks to allow for the kill itself to land after the window is chosen. */
const KILL_TICKS = 8;

async function compose(...args) {
  const { stdout, stderr } = await run("docker", ["compose", ...args], {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, WORLD_TICK_MS: String(TICK_MS) },
  });
  return stdout + stderr;
}

async function main() {
  let failures = 0;
  const check = (ok, message) => {
    log(`${ok ? "  ok  " : "  FAIL"}  ${message}`);
    if (!ok) failures++;
  };

  log("phase-1 gate");
  const before = await waitForHealth();
  // Whatever this world is running at, it comes back at the same rate.
  TICK_MS = before.tickMs;
  log(
    `  world ${before.worldId} at tick ${before.tick}, ` +
      `last snapshot ${before.lastSnapshotTick}`,
  );

  if (NATION === 0) {
    // Watch first, then choose. A spectator connection is the only way to see
    // the map before deciding whose side to be on.
    const spectator = new Watcher(null);
    await spectator.ready;
    const largest = largestNation(spectator.controllers);
    spectator.close();
    NATION = largest.nation;
    log(`  nation ${NATION} holds the most provinces (${largest.provinces})`);
  }

  const watcher = new Watcher();
  await watcher.ready;
  log(`  connected as nation ${NATION} at tick ${watcher.tick}`);

  // 1. A command, then a snapshot after it. This one is *inside* the snapshot,
  //    so the log is not what carries it.
  const early = await claimSomething(watcher, "early");
  log(
    `  claimed province ${early.province} for tick ${early.tick} ` +
      `(${early.refused} refused on the way, which is the rejection path)`,
  );

  log("  waiting for a snapshot after that command...");
  const until = Date.now() + SNAPSHOT_TIMEOUT_MS;
  let snapshotTick;
  for (;;) {
    const { body } = await health();
    snapshotTick = body.lastSnapshotTick;
    if (snapshotTick >= early.tick) break;
    if (Date.now() > until) throw new Error("no snapshot arrived in time");
    await sleep(2000);
  }
  log(`  snapshot at tick ${snapshotTick}`);

  // 2. A command *after* the newest snapshot. This one exists only in the log,
  //    and it is what "no lost commands" is about.
  const late = await claimSomething(watcher, "late");
  check(
    late.tick > snapshotTick,
    `the late claim (tick ${late.tick}) is after the snapshot (${snapshotTick})`,
  );
  log(`  claimed province ${late.province} for tick ${late.tick}`);

  // Let the world run on **long enough**, so that the restart has ticks to
  // replay into that this client has already seen and hashed.
  //
  // Measured from the clock rather than fixed at a handful of ticks. The
  // restored world resumes at the last logged command and starts ticking
  // immediately, while the watcher that checks the replay cannot connect until
  // `/health` says the world is up — half a second later, which at 50 ms a
  // tick is ten ticks it will never see. A four-tick window is comfortable at
  // five seconds a tick and gone entirely at fifty milliseconds, and the
  // symptom is this gate reporting that nothing was replayed.
  // **The kill has to land in a window, not after a fixed wait.**
  //
  // Decision 0005: a world resumes at its last durable record — the later of
  // the newest snapshot and the newest command. For the replay check to have
  // anything to compare, the world must then be some ticks *past* that record
  // when it dies, and this client must have seen them.
  //
  // A fixed wait cannot promise that: a twenty-tick pause after the last
  // command landed exactly on a snapshot boundary, the snapshot became the
  // durable record, and the world came back at the very tick the client had
  // last seen. So the wait is against the record itself, and the window ends
  // before the next snapshot can move it again.
  const margin = Math.max(4, Math.min(20, Math.ceil(1000 / TICK_MS)));
  let beforeKill;
  let durable;
  for (;;) {
    beforeKill = await waitForHealth();
    durable = Math.max(beforeKill.lastSnapshotTick, late.tick);
    // Far enough past the durable record to have something to replay, and
    // **before the next snapshot can become the record instead**. Measuring
    // the window from the record alone was not enough: the record was the last
    // *command*, and the next snapshot arrived twenty-two ticks later, so the
    // world came back at a point the client had never got to see.
    const nextSnapshot =
      (Math.floor(beforeKill.tick / SNAPSHOT_TICKS) + 1) * SNAPSHOT_TICKS;
    const past = beforeKill.tick - durable;
    if (past >= margin && beforeKill.tick + KILL_TICKS < nextSnapshot) break;
    await sleep(100);
  }
  await watcher.reaches(durable + margin, 60_000);
  const seen = new Map(watcher.hashes);
  const ownersAtLate = seen.has(late.tick);
  check(ownersAtLate, `saw the world at tick ${late.tick}`);
  watcher.close();

  // 3. The kill. SIGKILL, not a stop: a clean shutdown proves nothing.
  log("  SIGKILL to the world container");
  await compose("kill", "-s", "SIGKILL", "world");
  await sleep(1000);
  await compose("up", "-d", "world");

  // The replay watcher starts knocking **now**, while the container is still
  // coming up, so that it is attached on the world's first tick back rather
  // than on whichever one `/health` happens to notice.
  const replaying = Watcher.whenUp();

  const after = await waitForHealth();
  const logs = await compose(
    "logs",
    "--no-log-prefix",
    "--tail",
    "40",
    "world",
  );
  const resumed = /resuming at tick (\d+)/g;
  let resumedTick = null;
  for (const match of logs.matchAll(resumed)) resumedTick = Number(match[1]);
  log(`  the world came back, resuming at tick ${resumedTick}`);

  check(
    resumedTick === durable,
    `resumed at the last durable record: ${resumedTick} === ${durable} ` +
      `(snapshot ${beforeKill.lastSnapshotTick}, last command ${late.tick})`,
  );
  check(
    after.tick >= late.tick,
    `the tick did not restart from zero (${after.tick})`,
  );

  // 4. The strong check: replayed ticks must hash to what was seen live.
  const replayed = await replaying;
  await replayed.reaches(Math.max(...seen.keys()), 60_000);
  replayed.close();

  const shared = [...replayed.hashes.keys()]
    .filter((tick) => seen.has(tick))
    .sort((a, b) => a - b);
  check(
    shared.length > 0,
    `the restored world passed back through ${shared.length} tick(s) this client had seen`,
  );
  const mismatched = shared.filter(
    (tick) => replayed.hashes.get(tick) !== seen.get(tick),
  );
  check(
    mismatched.length === 0,
    mismatched.length === 0
      ? `every replayed tick hashes identically (${shared.join(", ")})`
      : `ticks that replayed differently: ${mismatched.join(", ")}`,
  );

  // 5. And the log itself, read directly. The hash check above would catch a
  //    missing command, but only by failing everywhere at once; this says
  //    which row is or is not there.
  const rows = await compose(
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "openfront",
    "-d",
    "openfront",
    "-t",
    "-A",
    "-c",
    `select tick || ':' || seq || ':' || nation_id || ':' || (payload->>'provinceId') ` +
      `from commands where world_id = '${WORLD_ID}' order by tick, seq`,
  );
  const logged = rows
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // **Matched without `seq`.** A command's position within its tick is real
  // and load-bearing — the replay depends on it — but it is not this gate's
  // subject, and it is not the player's to predict: since phase 7 the socket
  // layer writes a `nation_present` command of its own when a session
  // connects, so a player's first order is no longer seq 0. This gate asks
  // whether the order is in the log, which is what phase 1 is about.
  const inLog = (tick, province) =>
    logged.some((row) => {
      const [at, , nation, target] = row.split(":");
      return (
        Number(at) === tick &&
        Number(nation) === NATION &&
        Number(target) === province
      );
    });
  check(
    inLog(late.tick, late.province),
    `the late command is in the log: tick ${late.tick}, nation ${NATION}, province ${late.province}`,
  );
  check(
    inLog(early.tick, early.province),
    `the early command is still in the log: tick ${early.tick}, nation ${NATION}, province ${early.province}`,
  );

  check(after.healthy === true, "the restored world reports healthy");

  log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nFAIL —", error);
  process.exit(1);
});
