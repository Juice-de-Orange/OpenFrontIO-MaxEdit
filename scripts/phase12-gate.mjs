/**
 * Phase-12 gate: a deployment that survives a week, and a restore that was
 * really performed.
 *
 * CLAUDE.md §8: "a world runs uninterrupted for seven days on the deployment
 * host, with snapshot restore verified at least once."
 *
 * Seven days is wall clock, so this gate is not one run. `--start` records
 * where the world was and when; every later run measures the world against
 * that mark. The other seven legs are the conditions that would end the seven
 * days early, and they are checked on every run — a gate that only looked at
 * the clock would pass a world with its database on the public internet.
 *
 * Run it **on the host**, from the checkout, with the public URL:
 *
 *   node scripts/phase12-gate.mjs --start --url http://your.host:8095
 *   # ...seven days later, or any time in between...
 *   node scripts/phase12-gate.mjs --url http://your.host:8095
 *
 * And prove each leg can fail:
 *
 *   node scripts/phase12-gate.mjs --break=exposure    # read the dev compose file
 *   node scripts/phase12-gate.mjs --break=upgrade     # handshake against /health
 *   node scripts/phase12-gate.mjs --break=backup      # look in an empty directory
 *   node scripts/phase12-gate.mjs --break=continuity  # move the mark back a day
 *   node scripts/phase12-gate.mjs --break=season      # accept a tokenless play
 *
 * The mark lives in `.phase12-gate.local.json`, which `.gitignore` keeps out:
 * it names a host.
 *
 * **What this gate does not do.** It never restarts the world and never
 * touches the running database — a gate for uninterrupted running must not be
 * the thing that interrupts it. The restore drill builds a scratch database
 * beside the real one and drops it again.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const run = promisify(execFile);

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 16;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MARK_FILE = path.join(REPO_ROOT, ".phase12-gate.local.json");

const WORLD_ID = process.env.WORLD_ID ?? "world-0";
const TICK_MS = 5000;

/** §8's number. The mark has to be this old before the gate can pass. */
const REQUIRED_DAYS = 7;

/**
 * How far the tick may fall behind the wall clock over the whole window.
 *
 * Not zero: a restart costs up to a snapshot interval, the host reboots for a
 * kernel, and the tick loop's own drift is bounded but not nil. One percent of
 * seven days is about an hour and a half, which is generous for jitter and far
 * too small to hide an outage worth alerting about.
 */
const CONTINUITY_TOLERANCE = 0.01;

/** A dump older than this is not a backup, it is a souvenir. */
const MAX_BACKUP_AGE_H = 30;

const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const BREAK = arg("break");
const START = process.argv.includes("--start");
const BASE_URL = (
  arg("url") ??
  process.env.WORLD_URL ??
  "http://127.0.0.1:8095"
).replace(/\/$/, "");
const BACKUP_DIR =
  arg("backups") ?? process.env.BACKUP_DIR ?? "/srv/openfront/backups";

const log = (...parts) => console.log(...parts);

let failures = 0;
let skipped = 0;

function ok(what) {
  log(`  ok      ${what}`);
}
function fail(what, detail) {
  log(`  FAIL    ${what}`);
  if (detail !== undefined) log(`          ${detail}`);
  failures++;
}
function check(condition, what, detail) {
  if (condition) ok(what);
  else fail(what, detail);
  return condition;
}
/**
 * A leg that could not run. Counted and printed, never silent: a gate that
 * skips half of itself and prints "passed" is worse than one that fails.
 */
function skip(what, why) {
  log(`  SKIP    ${what}`);
  log(`          ${why}`);
  skipped++;
}

async function sh(command, args) {
  try {
    const { stdout } = await run(command, args, {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

async function health() {
  const response = await fetch(`${BASE_URL}/health`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`/health answered ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// The mark. Seven days cannot be measured in one run.
// ---------------------------------------------------------------------------

function readMark() {
  if (!fs.existsSync(MARK_FILE)) return null;
  return JSON.parse(fs.readFileSync(MARK_FILE, "utf-8"));
}

async function writeMark() {
  const state = await health();
  const mark = {
    url: BASE_URL,
    worldId: state.worldId,
    tick: state.tick,
    atMs: Date.now(),
    at: new Date().toISOString(),
    provinces: state.provinces,
  };
  fs.writeFileSync(MARK_FILE, `${JSON.stringify(mark, null, 2)}\n`);
  log(`Mark written to ${path.basename(MARK_FILE)}:`);
  log(`  world ${mark.worldId} at tick ${mark.tick}, ${mark.at}`);
  log("");
  log(`Run this gate again without --start in ${REQUIRED_DAYS} days.`);
  log(
    "Every other leg is checked on every run; only continuity needs the wait.",
  );
}

// ---------------------------------------------------------------------------
// The legs.
// ---------------------------------------------------------------------------

/** Nothing may be published to anything but loopback. */
async function legExposure() {
  log("Exposure — every published port is on loopback");

  // The counter-proof reads the development compose file on its own, which
  // publishes 0.0.0.0 by design. If this leg cannot tell the two apart it is
  // not checking anything.
  const args =
    BREAK === "exposure"
      ? ["compose", "-f", "docker-compose.yml", "config", "--format", "json"]
      : ["compose", "config", "--format", "json"];

  const result = await sh("docker", args);
  if (!result.ok) {
    skip(
      "published ports",
      `docker compose config failed: ${result.stderr.trim().split("\n")[0]}`,
    );
    return;
  }

  const config = JSON.parse(result.stdout);
  const published = [];
  for (const [name, service] of Object.entries(config.services ?? {})) {
    for (const port of service.ports ?? []) {
      published.push({
        name,
        hostIp: port.host_ip ?? "0.0.0.0",
        published: port.published,
      });
    }
  }

  check(published.length > 0, "the stack publishes something to check");
  const exposed = published.filter(
    (p) => p.hostIp !== "127.0.0.1" && p.hostIp !== "::1",
  );
  check(
    exposed.length === 0,
    `all ${published.length} published port(s) bound to loopback`,
    exposed.map((p) => `${p.name} on ${p.hostIp}:${p.published}`).join(", "),
  );
}

/** A world that does not come back from a reboot has not run for a week. */
async function legRestart() {
  log("Restart policy — the stack survives a reboot");

  const result = await sh("docker", ["compose", "config", "--format", "json"]);
  if (!result.ok) {
    skip("restart policies", "docker compose config failed");
    return;
  }
  const config = JSON.parse(result.stdout);
  const without = Object.entries(config.services ?? {})
    .filter(([, service]) => (service.restart ?? "no") === "no")
    .map(([name]) => name);

  check(
    without.length === 0,
    "every service has a restart policy",
    `no policy on: ${without.join(", ")}`,
  );
}

/** Identity armed, or the URL is an invitation to be anybody. */
async function legSeason() {
  log("Season — identity is armed");

  const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/ws`;
  const socket = new WebSocket(wsUrl);
  const messages = [];
  let closeCode = null;

  await new Promise((resolve) => {
    const done = () => resolve();
    const timer = setTimeout(done, 15000);
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          t: "hello",
          protocolVersion: PROTOCOL_VERSION,
          worldId: WORLD_ID,
          nation: 1,
          token: null,
        }),
      ),
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message.t);
      if (message.t === "full" || message.t === "reject") {
        clearTimeout(timer);
        done();
      }
    });
    socket.on("close", (code) => {
      closeCode = code;
      clearTimeout(timer);
      done();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
  socket.close();

  const wasPlayed = messages.includes("full");
  // The counter-proof accepts what the gate exists to refuse, so a run with
  // --break=season must fail here and nowhere else.
  const acceptable = BREAK === "season" ? wasPlayed : !wasPlayed;
  check(
    acceptable,
    "a hello claiming a nation with no token is not given that nation",
    `server sent [${messages.join(", ")}], close code ${closeCode}`,
  );
}

/** The client and the socket, from outside, the way a player meets them. */
async function legPublicSurface() {
  log("Public surface — the bundle and the socket, from outside");

  const page = await fetch(`${BASE_URL}/`, {
    signal: AbortSignal.timeout(20000),
  });
  const html = await page.text();
  check(page.ok, `GET / answers ${page.status}`);
  check(
    !html.includes("locals."),
    "index.html has no unrendered EJS placeholders",
    "run scripts/render-index.mjs over static/index.html before rsync",
  );

  const bundle = /src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(html);
  if (bundle === null) {
    fail("index.html names a module bundle");
  } else {
    const asset = await fetch(`${BASE_URL}${bundle[1]}`, {
      signal: AbortSignal.timeout(30000),
    });
    check(asset.ok, `the bundle it names is served (${bundle[1]})`);
  }

  const register = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  check(
    (register.headers.get("content-type") ?? "").includes("json"),
    "POST /register reaches the world, not index.html",
    "the proxy has no /register location, so try_files answers it",
  );

  // A status code is not proof: a 200 means the upgrade was swallowed and a
  // real client would wait forever. Only 101 counts.
  const path_ = BREAK === "upgrade" ? "/health" : "/ws";
  const handshake = await fetch(`${BASE_URL}${path_}`, {
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  check(
    handshake !== null && handshake.status === 101,
    "the WebSocket upgrade passes the proxy (101)",
    `got ${handshake === null ? "no answer" : handshake.status}`,
  );
}

/** Something has to notice, or seven days is a thing you find out afterwards. */
async function legWatchdog() {
  log("Watchdog — something is watching");

  const active = await sh("systemctl", ["is-active", "world-watchdog.timer"]);
  if (!active.ok && !active.stdout) {
    skip(
      "the watchdog timer",
      "systemctl not available — this leg needs the host",
    );
    return;
  }
  check(active.stdout.trim() === "active", "world-watchdog.timer is active");

  const last = await sh("systemctl", [
    "show",
    "world-watchdog.service",
    "--property=ExecMainStatus",
    "--property=Result",
  ]);
  if (last.ok) {
    const result = /Result=(\S+)/.exec(last.stdout)?.[1];
    check(
      result === "success",
      `the last watchdog run finished cleanly (Result=${result})`,
    );
  }
}

/** A backup nobody restored is a hope. So restore one. */
async function legBackupAndRestore() {
  log("Backups — a recent verified dump, and a restore that really ran");

  const dir =
    BREAK === "backup"
      ? fs.mkdtempSync(path.join(REPO_ROOT, ".empty-"))
      : BACKUP_DIR;
  // No initialiser: every path out of the catch returns, so a default here
  // would only be read if the catch stopped returning.
  let dumps;
  try {
    dumps = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".dump"))
      .map((f) => ({ f, stat: fs.statSync(path.join(dir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  } catch {
    skip("the backup directory", `cannot read ${dir}`);
    if (BREAK === "backup") fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  const bad = fs.readdirSync(dir).filter((f) => f.endsWith(".dump.bad"));
  check(
    bad.length === 0,
    "no dump has been quarantined as .bad",
    bad.join(", "),
  );

  const newest = dumps[0];
  const ageH =
    newest === undefined
      ? Infinity
      : (Date.now() - newest.stat.mtimeMs) / 3_600_000;
  const fresh = check(
    ageH < MAX_BACKUP_AGE_H,
    `the newest dump is younger than ${MAX_BACKUP_AGE_H}h`,
    newest === undefined
      ? `no dump in ${dir}`
      : `newest is ${ageH.toFixed(1)}h old`,
  );

  if (BREAK === "backup") {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (!fresh) return;

  // The drill. A scratch database beside the real one, never over it.
  const scratch = `phase12_restore_drill`;
  const dumpPath = path.join(dir, newest.f);
  const cid = await sh("docker", ["compose", "ps", "-q", "db"]);
  if (!cid.ok || cid.stdout.trim() === "") {
    skip("the restore drill", "no db container — this leg needs the host");
    return;
  }
  const container = cid.stdout.trim();

  await sh("docker", [
    "exec",
    container,
    "sh",
    "-c",
    `rm -f /tmp/${scratch}.dump`,
  ]);
  const copied = await sh("docker", [
    "cp",
    dumpPath,
    `${container}:/tmp/${scratch}.dump`,
  ]);
  if (!copied.ok) {
    skip(
      "the restore drill",
      "could not copy the dump into the database container",
    );
    return;
  }

  const psql = (sql, db = "postgres") =>
    sh("docker", [
      "exec",
      container,
      "psql",
      "-U",
      "openfront",
      "-d",
      db,
      "-tAc",
      sql,
    ]);

  await psql(`DROP DATABASE IF EXISTS ${scratch}`);
  const created = await psql(`CREATE DATABASE ${scratch}`);
  check(created.ok, "a scratch database can be created for the drill");

  const restored = await sh("docker", [
    "exec",
    container,
    "pg_restore",
    "-U",
    "openfront",
    "-d",
    scratch,
    `/tmp/${scratch}.dump`,
  ]);
  check(
    restored.ok,
    `pg_restore loaded ${newest.f} into a scratch database`,
    restored.stderr,
  );

  const counted = await psql(
    "select (select count(*) from commands) || ' ' || (select count(*) from snapshots)",
    scratch,
  );
  if (counted.ok) {
    const [commands, snapshots] = counted.stdout
      .trim()
      .split(/\s+/)
      .map(Number);
    check(
      snapshots > 0,
      `the restored database has real content (${commands} commands, ${snapshots} snapshots)`,
    );
  } else {
    fail("the restored database can be read", counted.stderr);
  }

  await psql(`DROP DATABASE IF EXISTS ${scratch}`);
  await sh("docker", [
    "exec",
    container,
    "sh",
    "-c",
    `rm -f /tmp/${scratch}.dump`,
  ]);
  ok("the scratch database was dropped again");
}

/** The seven days themselves. */
async function legContinuity() {
  log("Continuity — the tick kept step with the clock");

  const mark = readMark();
  if (mark === null) {
    skip(
      "seven uninterrupted days",
      `no mark yet — run with --start to set one, then wait ${REQUIRED_DAYS} days`,
    );
    return;
  }

  const state = await health();
  check(state.healthy === true, "/health reports healthy");
  check(
    state.worldId === mark.worldId,
    `still the world the mark was taken on (${mark.worldId})`,
    `now ${state.worldId}`,
  );
  check(
    state.provinces === mark.provinces,
    `still the same map (${mark.provinces} provinces)`,
    `now ${state.provinces} — a partition change is a new season, and a new mark`,
  );
  check(
    state.tick >= mark.tick,
    "the tick has not gone backwards",
    `mark ${mark.tick}, now ${state.tick} — a world that restarted from an older snapshot`,
  );

  // The counter-proof moves the mark a day into the past without moving the
  // tick, which is exactly the shape of a day-long outage.
  const elapsedMs =
    Date.now() - mark.atMs + (BREAK === "continuity" ? 86_400_000 : 0);
  const elapsedDays = elapsedMs / 86_400_000;
  const expectedTicks = elapsedMs / TICK_MS;
  const actualTicks = state.tick - mark.tick;
  const missing = expectedTicks - actualTicks;
  const missingRatio = expectedTicks === 0 ? 0 : missing / expectedTicks;

  log(
    `          ${elapsedDays.toFixed(2)} days elapsed, ` +
      `${actualTicks} ticks of an expected ${Math.round(expectedTicks)} ` +
      `(${missing > 0 ? "-" : "+"}${Math.abs(Math.round(missing))})`,
  );

  check(
    missingRatio <= CONTINUITY_TOLERANCE,
    `the world lost less than ${(CONTINUITY_TOLERANCE * 100).toFixed(0)}% of its ticks`,
    `missing ${(missingRatio * 100).toFixed(2)}% — about ` +
      `${((missing * TICK_MS) / 3_600_000).toFixed(1)} hours of world`,
  );

  check(
    elapsedDays >= REQUIRED_DAYS,
    `the world has run for ${REQUIRED_DAYS} days`,
    `${elapsedDays.toFixed(2)} days so far — ` +
      `${(REQUIRED_DAYS - elapsedDays).toFixed(2)} to go. Everything else has been checked.`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  if (START) {
    await writeMark();
    return 0;
  }

  log(`Phase-12 gate against ${BASE_URL}`);
  if (BREAK !== null)
    log(`  --break=${BREAK}: this run is expected to FAIL, at that leg`);
  log("");

  const legs = [
    legExposure,
    legRestart,
    legSeason,
    legPublicSurface,
    legWatchdog,
    legBackupAndRestore,
    legContinuity,
  ];

  for (const leg of legs) {
    try {
      await leg();
    } catch (error) {
      fail(`${leg.name} threw`, String(error));
    }
    log("");
  }

  if (skipped > 0) {
    log(`${skipped} leg(s) could not run. A skipped leg is not a passed leg.`);
  }
  if (failures === 0 && skipped === 0) {
    log("Phase 12: every leg passed.");
    return 0;
  }
  log(`${failures} failure(s), ${skipped} skipped.`);
  return 1;
}

process.exit(await main());
