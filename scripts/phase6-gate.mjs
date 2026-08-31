#!/usr/bin/env node
/**
 * The phase-6 gate: an overextended offensive stalls from supply alone.
 *
 * CLAUDE.md §8, phase 6 — and the load-bearing words are **alone** and
 * **without enemy action**. A division that got weaker while a war was going
 * on has proved nothing; this gate has to show one wasting away in a province
 * nobody attacked, and another one, in the same nation on the same tick, doing
 * fine because it is standing near a hub.
 *
 * So it raises exactly `sources x SUPPLY_SOURCE_THROUGHPUT` divisions, which
 * puts national coverage at exactly 1 and leaves **distance** as the only
 * thing that can differ between them. Then it watches, and refuses to count a
 * tick on which the front moved anywhere near either division.
 *
 * §8's other half — "full supply recompute stays under 50 ms on the largest
 * map" — is not here. It is a unit test, in `tests/server/Supply.test.ts`,
 * because it is a statement about a function and not about a world, and
 * measuring it through a WebSocket would measure the WebSocket.
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase6-gate.mjs
 *   docker compose up -d
 *
 * And prove it can fail:
 *
 *   node scripts/phase6-gate.mjs --break=supplied   # everyone next to a hub
 *   node scripts/phase6-gate.mjs --break=attrition  # nothing ever wastes away
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 8;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

const MESSAGE_TIMEOUT_MS = 300_000;

/** BUILDING_TYPES.length, and buildingIndex("supply_hub"). */
const BUILDING_COUNT = 10;
const SUPPLY_HUB = 7;

/** SUPPLY_SOURCE_THROUGHPUT in shared/config/supply.ts: divisions per source. */
const SUPPLY_SOURCE_THROUGHPUT = 4;

const BREAK = (() => {
  const arg = process.argv.find((a) => a.startsWith("--break="));
  return arg === undefined ? null : arg.slice("--break=".length);
})();

const log = (...parts) => console.log(...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Player {
  constructor(nation) {
    this.nation = nation;
    this.tick = null;
    this.economy = null;
    this.buildings = null;
    this.controllers = null;
    this.owners = null;
    this.acks = new Map();
    /** Every economy the wire has carried, by tick. */
    this.history = new Map();
    /** Which provinces changed hands on which tick — the clashes, exactly. */
    this.clashes = new Map();
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
    this.socket.on("error", (e) => {
      throw e;
    });
  }

  onMessage(message) {
    switch (message.t) {
      case "full":
        this.map = message.map;
        this.nations = message.nations;
        this.controllers = message.controllers;
        this.owners = message.owners;
        this.buildings = message.buildings;
        this.record(message.tick, message.economy);
        this.onReady();
        break;
      case "delta":
        this.clashes.set(
          message.tick,
          new Set(message.control.map(([province]) => province)),
        );
        for (const [province, holder] of message.control) {
          this.controllers[province] = holder;
        }
        for (const [province, owner] of message.owner) {
          this.owners[province] = owner;
        }
        for (const [province, building, count] of message.buildings) {
          this.buildings[province * BUILDING_COUNT + building] = count;
        }
        this.record(message.tick, message.economy);
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

  record(tick, economy) {
    this.tick = tick;
    this.economy = economy;
    if (economy !== null) this.history.set(tick, economy);
  }

  command(body, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ack for ${id}`)),
        MESSAGE_TIMEOUT_MS,
      );
      this.acks.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      this.socket.send(JSON.stringify({ t: "command", id, command: body }));
    });
  }

  /** Like `command`, but a refusal is the caller's problem to report. */
  async require(body, id) {
    const ack = await this.command(body, id);
    if (!ack.accepted) {
      throw new Error(`${body.kind} refused: ${ack.reason}`);
    }
    return ack;
  }

  async waitFor(predicate, what, timeoutMs = MESSAGE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  /** The same wait, but running out of time is an answer rather than a throw. */
  async waitUntil(predicate, what, timeoutMs) {
    return this.waitFor(predicate, what, timeoutMs)
      .then(() => true)
      .catch(() => false);
  }

  close() {
    this.socket.close();
  }
}

function largestNation(controllers) {
  const held = new Map();
  for (const nation of controllers) {
    if (nation === 0) continue;
    held.set(nation, (held.get(nation) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [nation, count] of held) {
    if (count > bestCount) {
      best = nation;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The province graph, read from the artefact both sides load (decision 0006).
 *
 * Supply is a distance over this graph, so a gate that cannot measure distance
 * cannot say anything about supply. Reading `provinces.json` is reading the
 * map, not reimplementing the server.
 */
async function neighbourLists(mapId) {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const repo = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  const meta = JSON.parse(
    await readFile(
      path.join(repo, "resources", "maps", mapId, "provinces.json"),
      "utf-8",
    ),
  );
  const neighbours = new Map();
  for (const province of meta.provinces) {
    neighbours.set(province.id, province.neighbours);
  }
  return neighbours;
}

/**
 * Hop distance from the nation's capitals, over ground it holds.
 *
 * Unweighted, unlike the server's own search: the gate does not need to agree
 * with the server about how far supply reaches, only to find provinces that
 * are plainly near and plainly far. Agreeing exactly would mean copying the
 * cost model, and a gate that copies the thing it checks checks nothing.
 */
function hopsFromHome(player, neighbours, capitals) {
  const depth = new Map();
  const queue = [...capitals];
  for (const capital of capitals) depth.set(capital, 0);
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head];
    for (const next of neighbours.get(here) ?? []) {
      if (depth.has(next)) continue;
      if (player.controllers[next] !== player.nation) continue;
      if (player.owners[next] !== player.nation) continue;
      depth.set(next, (depth.get(here) ?? 0) + 1);
      queue.push(next);
    }
  }
  return depth;
}

async function sweep(player) {
  const divisions = [...player.economy.divisions];
  const lines = [...player.economy.productionLines];
  if (divisions.length === 0 && lines.length === 0) return;
  log(
    `  clearing ${divisions.length} division(s) and ${lines.length} line(s) ` +
      `left by an earlier run`,
  );
  for (const division of divisions) {
    await player.command(
      { kind: "disband_division", divisionId: division.id },
      `sweep-div-${division.id}`,
    );
  }
  for (const line of lines) {
    await player.command(
      { kind: "remove_production_line", lineId: line.id },
      `sweep-line-${line.id}`,
    );
  }
  await player.waitUntil(
    (p) =>
      p.economy.divisions.length === 0 &&
      p.economy.productionLines.length === 0,
    "the old divisions and lines to go",
    30_000,
  );
}

const WATCH_BUDGET_MS = 120_000;
const SETUP_BUDGET_MS = 120_000;

async function main() {
  let failures = 0;
  const check = (ok, message) => {
    log(`${ok ? "  ok  " : "  FAIL"}  ${message}`);
    if (ok) return;
    failures++;
    if (BREAK !== null) {
      log(`FAIL (${failures}) — stopped at the first failure, as intended`);
      process.exit(1);
    }
  };

  log("phase-6 gate");
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const health = await fetch(HEALTH_URL).then((r) => r.json());
  log(
    `  world ${health.worldId} at tick ${health.tick}, ${health.tickMs} ms a tick`,
  );
  if (health.tickMs > MAX_TICK_MS) {
    log("");
    log(`  This world ticks every ${health.tickMs} ms. Attrition is a couple`);
    log(
      "  of percent a tick, so watching a division come apart takes hundreds",
    );
    log("  of them. Bring the stack up with a faster clock:");
    log("");
    log("    WORLD_TICK_MS=50 docker compose up -d --build");
    log("    node scripts/phase6-gate.mjs");
    log("");
    process.exit(2);
  }

  const spectator = new Player(null);
  await spectator.ready;
  const nation = largestNation(spectator.controllers);
  const mapId = spectator.map.id;
  spectator.close();

  const neighbours = await neighbourLists(mapId);
  const player = new Player(nation);
  await player.ready;
  check(
    player.economy !== null,
    "a nation is sent its own economy; a spectator is not",
  );
  check(
    player.economy.divisions.every((d) => d.supply !== undefined),
    "the wire carries a supply figure per division",
  );
  await sweep(player);

  // The nation's own capitals, from the artefact. Supply hubs would count too;
  // a nation that has never built one has exactly its capitals.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const repo = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  const meta = JSON.parse(
    await readFile(
      path.join(repo, "resources", "maps", mapId, "provinces.json"),
      "utf-8",
    ),
  );
  const capitals = meta.provinces
    .filter((p) => p.capital)
    .map((p) => p.id)
    .filter(
      (id) => player.controllers[id] === nation && player.owners[id] === nation,
    );
  const hubs = player.buildings.filter(
    (unused, index) =>
      index % BUILDING_COUNT === SUPPLY_HUB && player.buildings[index] > 0,
  ).length;
  const sources = capitals.length + hubs;
  check(sources > 0, `the nation draws supply from ${sources} source(s)`);

  const depth = hopsFromHome(player, neighbours, capitals);
  const ranked = [...depth.entries()].sort((a, b) => a[1] - b[1]);
  check(
    ranked.length >= 4 && ranked[ranked.length - 1][1] >= 3,
    `it holds ${ranked.length} connected provinces, the furthest ` +
      `${ranked[ranked.length - 1]?.[1]} hops from home`,
  );

  // Exactly what the hubs can carry, so national coverage is 1 and the only
  // thing that can differ between these divisions is how far out they are.
  const wanted = Math.min(4, sources * SUPPLY_SOURCE_THROUGHPUT);
  const near = ranked.slice(0, 1).map(([province]) => province);
  const far =
    BREAK === "supplied"
      ? ranked.slice(1, wanted).map(([province]) => province)
      : ranked.slice(-(wanted - 1)).map(([province]) => province);
  if (BREAK === "supplied") {
    log("  --break=supplied: everybody stays next to a hub");
  }

  const raised = [];
  for (const province of [...near, ...far]) {
    const ack = await player.command(
      { kind: "raise_division", provinceId: province },
      `raise-${province}`,
    );
    if (!ack.accepted) {
      log(`  province ${province} refused a division: ${ack.reason}`);
      continue;
    }
    const appeared = await player.waitUntil(
      (p) => p.economy.divisions.length > raised.length,
      `a division in province ${province}`,
      20_000,
    );
    if (!appeared) continue;
    raised.push(
      player.economy.divisions[player.economy.divisions.length - 1].id,
    );
  }
  check(raised.length >= 2, `raised ${raised.length} divisions to compare`);

  const where = new Map(
    player.economy.divisions.map((d) => [d.id, d.provinceId]),
  );
  const supplyNow = new Map(
    player.economy.divisions.map((d) => [d.id, d.supply]),
  );
  for (const id of raised) {
    log(
      `  division ${id} in province ${where.get(id)}, ` +
        `${depth.get(where.get(id))} hops out, supply ` +
        `${((supplyNow.get(id) ?? 0) * 100).toFixed(0)}%`,
    );
  }

  const best = raised.reduce((a, b) =>
    (supplyNow.get(a) ?? 0) >= (supplyNow.get(b) ?? 0) ? a : b,
  );
  const worst = raised.reduce((a, b) =>
    (supplyNow.get(a) ?? 0) <= (supplyNow.get(b) ?? 0) ? a : b,
  );
  check(
    (supplyNow.get(best) ?? 0) - (supplyNow.get(worst) ?? 0) > 0.05,
    `the division at the end of the line is worse supplied than the one at ` +
      `home: ${((supplyNow.get(worst) ?? 0) * 100).toFixed(0)}% against ` +
      `${((supplyNow.get(best) ?? 0) * 100).toFixed(0)}%`,
  );

  // They start empty, so give them something to lose first.
  log("  letting them draw equipment, then watching the line stretch...");
  await player.waitUntil(
    (p) => (p.economy.divisions.find((d) => d.id === worst)?.strength ?? 0) > 0,
    "the divisions to draw something",
    SETUP_BUDGET_MS,
  );

  let lastTick = player.tick;
  const startStrength = new Map(
    player.economy.divisions.map((d) => [d.id, d.strength]),
  );
  let disturbed = 0;
  let worstMax = startStrength.get(worst) ?? 0;
  const until = Date.now() + WATCH_BUDGET_MS;
  while (Date.now() < until) {
    await sleep(25);
    for (let tick = lastTick + 1; tick <= player.tick; tick++) {
      const economy = player.history.get(tick);
      if (economy === undefined) continue;
      lastTick = tick;
      const moved = player.clashes.get(tick);
      if (moved === undefined) continue;
      // "Without enemy action" is an assertion about the window, not a hope.
      // A tick on which the front came near either division is a tick this
      // gate cannot use, and it says how many there were.
      for (const id of [best, worst]) {
        const at = where.get(id);
        if (at === undefined) continue;
        if (moved.has(at)) disturbed++;
        else if ((neighbours.get(at) ?? []).some((n) => moved.has(n))) {
          disturbed++;
        }
      }
    }
    const now = player.economy.divisions.find((d) => d.id === worst);
    if (now !== undefined) worstMax = Math.max(worstMax, now.strength);
  }

  const bestNow = player.economy.divisions.find((d) => d.id === best);
  const worstNow = player.economy.divisions.find((d) => d.id === worst);
  check(
    bestNow !== undefined && worstNow !== undefined,
    "both divisions are still on the roster",
  );
  log(
    `  the front came within reach of one of them on ${disturbed} tick(s) of ` +
      `the ${player.tick - (lastTick - (player.tick - lastTick))} watched`,
  );

  const worstStrength =
    BREAK === "attrition" ? worstMax : (worstNow?.strength ?? 0);
  check(
    worstStrength < worstMax - 1e-9,
    `the division at the end of the line came apart on its own: ` +
      `${(worstMax * 100).toFixed(1)}% at its best, ` +
      `${(worstStrength * 100).toFixed(1)}% now`,
  );
  check(
    (worstNow?.supply ?? 1) < 1,
    `and it is still short: ${((worstNow?.supply ?? 1) * 100).toFixed(0)}% ` +
      `of what it needs is getting through`,
  );
  check(
    disturbed === 0,
    `with no enemy action at either division for the whole window ` +
      `(${disturbed} disturbed ticks)`,
  );
  check(
    (bestNow?.supply ?? 0) >= 1 - 1e-9,
    `while the division at home has everything it asks for ` +
      `(${((bestNow?.supply ?? 0) * 100).toFixed(0)}%)`,
  );

  const after = await fetch(HEALTH_URL).then((r) => r.json());
  check(
    after.healthy === true,
    `the world stayed healthy throughout (${after.lagMs} ms behind at tick ${after.tick})`,
  );

  player.close();
  log(failures === 0 ? "PASS" : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
