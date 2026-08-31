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
const PROTOCOL_VERSION = 6;
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
        }),
      ),
    );
    this.socket.on("message", (raw) =>
      this.onMessage(JSON.parse(raw.toString())),
    );
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

async function compose(...args) {
  const { stdout, stderr } = await run("docker", ["compose", ...args], {
    maxBuffer: 8 * 1024 * 1024,
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

  // Let the world run on a little, so the restart has ticks to replay into
  // that this client has already seen and hashed.
  await watcher.reaches(late.tick + 4);
  const seen = new Map(watcher.hashes);
  const ownersAtLate = seen.has(late.tick);
  check(ownersAtLate, `saw the world at tick ${late.tick}`);
  watcher.close();

  // 3. The kill. SIGKILL, not a stop: a clean shutdown proves nothing.
  log("  SIGKILL to the world container");
  await compose("kill", "-s", "SIGKILL", "world");
  await sleep(1000);
  await compose("up", "-d", "world");

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
    resumedTick === late.tick,
    `resumed at the last durable tick: ${resumedTick} === ${late.tick}`,
  );
  check(
    after.tick >= late.tick,
    `the tick did not restart from zero (${after.tick})`,
  );

  // 4. The strong check: replayed ticks must hash to what was seen live.
  const replayed = new Watcher();
  await replayed.ready;
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
  check(
    logged.includes(`${late.tick}:0:${NATION}:${late.province}`),
    `the late command is in the log: ${late.tick}:0:${NATION}:${late.province}`,
  );
  check(
    logged.includes(`${early.tick}:0:${NATION}:${early.province}`),
    `the early command is still in the log: ${early.tick}:0:${NATION}:${early.province}`,
  );

  check(after.healthy === true, "the restored world reports healthy");

  log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nFAIL —", error);
  process.exit(1);
});
