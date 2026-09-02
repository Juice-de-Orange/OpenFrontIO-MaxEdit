/**
 * Phase-11 gate: accounts and identity, proven over a live WebSocket.
 *
 * CLAUDE.md §8: "a session that claims a nation it does not hold is refused,
 * and is sent nothing about that nation. Two browsers signed in to the same
 * account share one nation and one session; two accounts cannot hold the
 * same nation. The refusal survives a world restart."
 *
 * Identity is armed by `WORLD_SEASON=open` (decision 0019), so this gate
 * restarts the world into season mode, proves every sentence, restarts it
 * once more to prove the refusal is durable, and puts the workbench mode
 * back at the end — the other gates depend on an open world.
 *
 * Every run registers fresh accounts and scans for unclaimed nations, so it
 * can be run repeatedly against one world until the nations run out; then
 * `docker compose down -v` is the answer, and the gate says so.
 *
 * Run against a fast world:
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase11-gate.mjs
 *
 * And prove it can fail:
 *
 *   node scripts/phase11-gate.mjs --break=keys   # the impostor gets the real key
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const run = promisify(execFile);

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const REGISTER_URL =
  process.env.WORLD_REGISTER ?? "http://localhost:3000/register";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 21;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

/** The clock the restarts carry through — the compose-up trap, paid for. */
const TICK_MS = 50;

const BREAK = (() => {
  const arg = process.argv.find((a) => a.startsWith("--break="));
  return arg === undefined ? null : arg.slice("--break=".length);
})();

const log = (...parts) => console.log(...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function ok(what) {
  log(`  ok    ${what}`);
}
function fail(what) {
  log(`  FAIL  ${what}`);
  failures++;
}
function check(condition, what) {
  if (condition) ok(what);
  else fail(what);
  return condition;
}

/**
 * One connection, recorded rather than interpreted: the gate's whole
 * subject is *what the server sent before it hung up*, so every message and
 * the close code are kept verbatim.
 */
class Session {
  constructor(nation, token) {
    this.messages = [];
    this.closeCode = null;
    this.closed = new Promise((resolve) => {
      this.onClosed = resolve;
    });
    this.settled = new Promise((resolve) => {
      this.onSettled = resolve;
    });
    this.socket = new WebSocket(WS_URL);
    this.socket.on("open", () =>
      this.socket.send(
        JSON.stringify({
          t: "hello",
          protocolVersion: PROTOCOL_VERSION,
          worldId: WORLD_ID,
          nation,
          token,
        }),
      ),
    );
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      // The handshake settles on the first substantive answer.
      if (message.t === "welcome" || message.t === "reject") this.onSettled();
    });
    this.socket.on("close", (code) => {
      this.closeCode = code;
      this.onClosed();
      this.onSettled();
    });
    this.socket.on("error", () => {});
  }

  kinds() {
    return this.messages.map((message) => message.t);
  }

  full() {
    return this.messages.find((message) => message.t === "full");
  }

  /** The freshest economy this session was sent, full or delta. */
  latestEconomy() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (
        (message.t === "full" || message.t === "delta") &&
        message.economy !== null &&
        message.economy !== undefined
      ) {
        return message.economy;
      }
    }
    return null;
  }

  close() {
    this.socket.close();
  }
}

async function register(name) {
  const response = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`register said ${response.status}`);
  return response.json();
}

async function health() {
  const response = await fetch(HEALTH_URL);
  if (!response.ok) throw new Error(`health said ${response.status}`);
  return response.json();
}

async function compose(season, ...args) {
  const { stdout, stderr } = await run("docker", ["compose", ...args], {
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      WORLD_TICK_MS: String(TICK_MS),
      WORLD_SEASON: season ? "open" : "",
    },
  });
  return stdout + stderr;
}

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const body = await fetch(HEALTH_URL).then((r) => r.json());
      if (body.tick > 0) return body;
    } catch {
      // The world is still coming up. That is what this loop is for.
    }
    if (Date.now() > deadline) throw new Error("the world never came back");
    await sleep(250);
  }
}

/**
 * Connect as this account until a nation lets it in, and report which.
 * Earlier runs' claims make low nations "taken"; the scan walks past them.
 */
async function claimSomeNation(token, nations, avoid = new Set()) {
  for (let nation = 1; nation <= nations; nation++) {
    if (avoid.has(nation)) continue;
    const session = new Session(nation, token);
    await session.settled;
    if (session.kinds().includes("welcome")) return { nation, session };
    session.close();
    await session.closed;
  }
  return null;
}

async function main() {
  const before = await health();
  log("phase-11 gate");
  log(
    `  world ${before.worldId} at tick ${before.tick}, ${before.tickMs} ms a tick`,
  );
  if (before.tickMs > MAX_TICK_MS) {
    log(
      `  this world ticks every ${before.tickMs} ms and the gate restarts ` +
        `it twice. Restart it faster first:\n` +
        `    WORLD_TICK_MS=50 docker compose up -d --build`,
    );
    process.exit(2);
  }
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  log("  restarting the world as a season (WORLD_SEASON=open)...");
  await compose(true, "up", "-d", "world");
  const season = await waitForHealth();
  log(`  the season world is up at tick ${season.tick}`);

  try {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const mallory = await register("Mallory");
    ok("three accounts registered, each holding its one copy of a token");

    const nationCount = 52;
    const claimed = await claimSomeNation(alice.token, nationCount);
    if (claimed === null) {
      log(
        "  a world this gate cannot use: every nation is already claimed — " +
          "docker compose down -v and start fresh",
      );
      process.exit(2);
    }
    const { nation, session: aliceSession } = claimed;
    ok(`Alice's account claimed nation ${nation} — free nations are joinable`);

    // The season opening's 52 configure commands apply on the tick after
    // the world lands, and a hello can arrive inside that same tick — so
    // this reads the running wire rather than the first snapshot.
    const deadline = Date.now() + 10_000;
    let inheritedRegent = null;
    while (Date.now() < deadline) {
      inheritedRegent = aliceSession.latestEconomy()?.regent ?? null;
      if (inheritedRegent?.enabled === true) break;
      await sleep(100);
    }
    check(
      inheritedRegent?.enabled === true,
      "and inherited a nation the regent was already playing — the season " +
        "opening kept §6.10's promise (decision 0018)",
    );

    // -----------------------------------------------------------------------
    // The impostor. With --break=keys it steals Alice's real token, and the
    // refusal check below is what has to notice.
    // -----------------------------------------------------------------------
    const key = BREAK === "keys" ? alice.token : mallory.token;
    const impostor = new Session(nation, key);
    await impostor.settled;
    await sleep(200);
    const refused =
      !impostor.kinds().includes("full") && !impostor.kinds().includes("delta");
    check(
      refused,
      `a session claiming nation ${nation} without holding it is refused ` +
        `and sent nothing about it (messages: ${impostor.kinds().join(", ") || "none"})`,
    );
    impostor.close();

    const tokenless = new Session(nation, null);
    await tokenless.settled;
    check(
      !tokenless.kinds().includes("full"),
      "and playing without any credential at all is refused too",
    );
    tokenless.close();

    // -----------------------------------------------------------------------
    // Two accounts, one nation each; a second nation is refused.
    // -----------------------------------------------------------------------
    const bobClaim = await claimSomeNation(
      bob.token,
      nationCount,
      new Set([nation]),
    );
    if (bobClaim === null) {
      log("  a world this gate cannot use: no second nation left for Bob");
      process.exit(2);
    }
    ok(`Bob's account claimed nation ${bobClaim.nation} of its own`);

    const greedy = await claimSomeNation(
      bob.token,
      nationCount,
      new Set([nation, bobClaim.nation]),
    );
    check(
      greedy === null,
      "and could not claim a second nation this season — one account, one " +
        "nation (§10)",
    );
    if (greedy !== null) greedy.session.close();

    // -----------------------------------------------------------------------
    // Two browsers, one account: the newer connection takes the session
    // over; the older one is told so and does not fight back.
    // -----------------------------------------------------------------------
    const second = new Session(nation, alice.token);
    await second.settled;
    await aliceSession.closed;
    check(
      second.kinds().includes("welcome") &&
        aliceSession.closeCode === 4006 &&
        second.closeCode === null,
      `a second browser on Alice's account took the session over — the ` +
        `first was closed with 4006 (got ${aliceSession.closeCode}) and the ` +
        `second plays on`,
    );

    // -----------------------------------------------------------------------
    // The restart. Claims live in Postgres, not in the process: the same
    // impostor is refused by the world that comes back.
    // -----------------------------------------------------------------------
    log("  restarting the season world...");
    second.close();
    await compose(true, "restart", "world");
    await waitForHealth();

    const again = new Session(nation, mallory.token);
    await again.settled;
    check(
      !again.kinds().includes("full") && !again.kinds().includes("welcome"),
      "the refusal survived the restart — the claim is the database's, not " +
        "the process's",
    );
    again.close();

    const owner = new Session(nation, alice.token);
    await owner.settled;
    check(
      owner.kinds().includes("welcome"),
      "while the rightful account resumed its nation without a second claim",
    );
    owner.close();
  } finally {
    // The other gates depend on a workbench world: put it back, with the
    // clock this chain runs on (the compose-up trap, both halves).
    log("  restoring the workbench world (season off)...");
    await compose(false, "up", "-d", "world");
    await waitForHealth();
  }

  const after = await health();
  check(
    after.healthy && after.tickMs <= MAX_TICK_MS,
    `the world is back on the workbench clock and healthy ` +
      `(${after.tickMs} ms a tick at tick ${after.tick})`,
  );

  log(failures === 0 ? "PASS" : "FAIL");
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  log(`  FAIL  ${error.message}`);
  process.exit(1);
});
