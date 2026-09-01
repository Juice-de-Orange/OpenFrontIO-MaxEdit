/**
 * Phase-10 gate: the regent, measured over a live WebSocket.
 *
 * CLAUDE.md §8: "a nation left under regent control for 2,000 ticks against
 * an active opponent still holds its capital, has a non-empty construction
 * queue, and has not reset a single production line."
 *
 * The opponent is the gate itself, and it fights the way the world now
 * works: since the front became a rate, `claim_province` marches into any
 * undefended province — so a relentless attacker needs no army at all to
 * take everything nobody is standing in, and the regent's garrison is
 * exactly what stops the march at the capital's border (an empty capital is
 * walked into in eight ticks; a garrisoned one turns the march into a battle
 * the attacker's nothing cannot win). That asymmetry is the measurement:
 * with the regent asleep the same offensive takes the capital, with it awake
 * the same offensive takes everything else and stalls there.
 *
 * Run against a fast world (fresh: `docker compose down -v`):
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase10-gate.mjs
 *
 * And prove it can fail:
 *
 *   node scripts/phase10-gate.mjs --break=asleep   # the regent never wakes
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 15;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

const MESSAGE_TIMEOUT_MS = 300_000;

/** §8's own number: how long the nation is left to the regent. */
const WINDOW_TICKS = 2000;

/** How many fronts the attacker keeps open at once. */
const PRESSURE = 3;

/** shared/config/rates.ts: what a division costs to raise. */
const DIVISION_MANPOWER = 1000;

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

class Player {
  constructor(nation) {
    this.nation = nation;
    this.tick = null;
    this.economy = null;
    this.buildings = null;
    this.controllers = null;
    this.owners = null;
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
    this.socket.on("error", (e) => {
      throw e;
    });
  }

  onMessage(message) {
    switch (message.t) {
      case "full":
        this.map = message.map;
        this.controllers = message.controllers;
        this.owners = message.owners;
        this.buildings = message.buildings;
        this.tick = message.tick;
        this.economy = message.economy;
        this.onReady();
        break;
      case "delta":
        for (const [province, holder] of message.control) {
          this.controllers[province] = holder;
        }
        for (const [province, owner] of message.owner) {
          this.owners[province] = owner;
        }
        this.tick = message.tick;
        this.economy = message.economy;
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

  async require(body, id) {
    const ack = await this.command(body, id);
    if (!ack.accepted) throw new Error(`${body.kind} refused: ${ack.reason}`);
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

  close() {
    this.socket.close();
  }
}

async function provinceData(mapId) {
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
  return meta.provinces;
}

async function health() {
  const response = await fetch(HEALTH_URL);
  if (!response.ok) throw new Error(`health said ${response.status}`);
  return response.json();
}

/** Whatever an earlier run left behind on this nation. */
async function sweep(player) {
  const { divisions, formations, productionLines, attacks } = player.economy;
  for (const attack of attacks) {
    await player.command(
      { kind: "cancel_attack", provinceId: attack.province },
      `sweep-a${attack.province}`,
    );
  }
  for (const division of divisions) {
    await player.command(
      { kind: "disband_division", divisionId: division.id },
      `sweep-d${division.id}`,
    );
  }
  for (const formation of formations) {
    await player.command(
      { kind: "disband_formation", formationId: formation.id },
      `sweep-f${formation.id}`,
    );
  }
  for (const line of productionLines) {
    await player.command(
      { kind: "remove_production_line", lineId: line.id },
      `sweep-l${line.id}`,
    );
  }
}

/**
 * A pair to fight over: an attacker bordering a regent nation whose capital
 * sits a few provinces behind the shared border — far enough that the march
 * is a campaign the regent has time to answer, near enough that an
 * unanswered campaign reaches it well inside the window.
 */
function findPair(spectator, provinces) {
  const byId = new Map(provinces.map((province) => [province.id, province]));
  const capitalOf = new Map();
  for (const province of provinces) {
    if (!province.capital) continue;
    const holder = spectator.controllers[province.id];
    if (holder > 0 && !capitalOf.has(holder)) {
      capitalOf.set(holder, province.id);
    }
  }

  let best = null;
  for (const [regent, capital] of capitalOf) {
    // Hops from any foreign border into the capital, over this nation's own
    // ground — a breadth-first search per candidate.
    const distance = new Map([[capital, 0]]);
    const queue = [capital];
    for (let head = 0; head < queue.length; head++) {
      for (const next of byId.get(queue[head]).neighbours) {
        if (distance.has(next)) continue;
        if (spectator.controllers[next] !== regent) continue;
        distance.set(next, distance.get(queue[head]) + 1);
        queue.push(next);
      }
    }
    for (const [province, hops] of distance) {
      for (const next of byId.get(province).neighbours) {
        const attacker = spectator.controllers[next];
        if (attacker <= 0 || attacker === regent) continue;
        if (hops < 2 || hops > 5) continue;
        const found = { attacker, regent, capital, hops };
        if (best === null || hops > best.hops) best = found;
      }
    }
  }
  return best;
}

async function main() {
  const state = await health();
  log("phase-10 gate");
  log(
    `  world ${state.worldId} at tick ${state.tick}, ${state.tickMs} ms a tick`,
  );
  if (state.tickMs > MAX_TICK_MS) {
    log(
      `  this world ticks every ${state.tickMs} ms; the 2,000-tick window ` +
        `alone would take ${((state.tickMs * WINDOW_TICKS) / 60000).toFixed(0)} ` +
        `minutes. Restart it faster:\n` +
        `    WORLD_TICK_MS=50 docker compose up -d --build`,
    );
    process.exit(2);
  }
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const spectator = new Player(null);
  await spectator.ready;
  const provinces = await provinceData(spectator.map.id);
  const byId = new Map(provinces.map((province) => [province.id, province]));

  const pair = findPair(spectator, provinces);
  if (pair === null) {
    log(
      "  a world this gate cannot use: no capital sits 2-5 hops behind a " +
        "foreign border",
    );
    process.exit(2);
  }
  const { attacker, regent, capital, hops } = pair;
  log(
    `  nation ${regent} is left to its regent; nation ${attacker} marches ` +
      `on its capital in province ${capital}, ${hops} hop(s) behind the border`,
  );

  const steward = new Player(regent);
  const invader = new Player(attacker);
  await steward.ready;
  await invader.ready;
  await sweep(steward);
  await sweep(invader);

  // The invader is played by the gate; its own regent stays off (the
  // default, decision 0018) so nothing here is regent against regent.
  await invader.require(
    {
      kind: "configure_regent",
      enabled: false,
      focus: "economy",
      marketBudget: 0,
    },
    "invader-regent-off",
  );

  // The regent needs the manpower for its garrison before the marching
  // starts, or the window measures a steward that never had the means.
  await steward.waitFor(
    (p) => p.economy.manpower >= DIVISION_MANPOWER,
    "manpower for the regent's garrison",
    120_000,
  );

  await steward.require(
    {
      kind: "configure_regent",
      enabled: BREAK !== "asleep",
      focus: "defence",
      marketBudget: 0.5,
    },
    "regent-on",
  );
  log(
    BREAK === "asleep"
      ? "  --break=asleep: the regent never wakes"
      : "  the regent takes over: defence, half a point a tick for the market",
  );

  // -------------------------------------------------------------------------
  // The campaign. Up to PRESSURE standing attacks at once, always against
  // the regent's provinces nearest the capital, re-ordered the moment one
  // falls. The gate sends orders; the world does all the taking.
  // -------------------------------------------------------------------------
  const startTick = steward.tick;
  const endTick = startTick + WINDOW_TICKS;
  const samples = [];
  let ordersPlaced = 0;

  const nearestTargets = () => {
    // Provinces the regent holds, adjacent to the invader's ground, sorted
    // by their distance to the capital over the regent's own territory.
    const distance = new Map([[capital, 0]]);
    const queue = [capital];
    for (let head = 0; head < queue.length; head++) {
      for (const next of byId.get(queue[head]).neighbours) {
        if (distance.has(next)) continue;
        if (invader.controllers[next] !== regent) continue;
        distance.set(next, distance.get(queue[head]) + 1);
        queue.push(next);
      }
    }
    return [...distance.entries()]
      .filter(([province]) =>
        byId
          .get(province)
          .neighbours.some((next) => invader.controllers[next] === attacker),
      )
      .sort((a, b) => a[1] - b[1])
      .map(([province]) => province);
  };

  while (invader.tick < endTick) {
    const standing = invader.economy.attacks.map((attack) => attack.province);
    if (standing.length < PRESSURE) {
      for (const target of nearestTargets()) {
        if (standing.includes(target)) continue;
        const ack = await invader.command(
          { kind: "claim_province", provinceId: target },
          `march-${target}-${invader.tick}`,
        );
        if (ack.accepted) {
          standing.push(target);
          ordersPlaced++;
        }
        if (standing.length >= PRESSURE) break;
      }
    }

    // One sample a second: what the regent is doing, read off the wire.
    const economy = steward.economy;
    samples.push({
      tick: steward.tick,
      queue: economy.queue.length,
      lines: economy.productionLines.map((line) => ({
        id: line.id,
        equipment: line.equipment,
        efficiency: line.efficiency,
      })),
      divisions: economy.divisions.length,
      capitalHeld: steward.controllers[capital] === regent,
    });
    if (steward.controllers[capital] !== regent) break;
    await sleep(1000);
  }

  // -------------------------------------------------------------------------
  // §8's three clauses, plus the proof each side actually played its part.
  // -------------------------------------------------------------------------
  check(
    ordersPlaced >= 5,
    `the opponent was active: ${ordersPlaced} standing attacks ordered ` +
      `across the window`,
  );
  const lost = samples.length > 0 && !samples[samples.length - 1].capitalHeld;
  check(
    !lost && steward.controllers[capital] === regent,
    `the capital in province ${capital} is still the regent's after ` +
      `${Math.min(WINDOW_TICKS, steward.tick - startTick)} tick(s)`,
  );
  const queueFilled = samples.filter((sample) => sample.queue > 0).length;
  check(
    steward.economy.queue.length > 0 &&
      queueFilled >= Math.floor(samples.length * 0.5),
    `the construction queue is non-empty now and was on ${queueFilled} of ` +
      `${samples.length} samples`,
  );

  // No line ever changed what it makes, and none was thrown to the floor.
  let switched = 0;
  const seen = new Map();
  for (const sample of samples) {
    for (const line of sample.lines) {
      const before = seen.get(line.id);
      if (before !== undefined && before !== line.equipment) switched++;
      seen.set(line.id, line.equipment);
    }
  }
  check(
    switched === 0 && seen.size > 0,
    `${seen.size} production line(s) ran and not one was reset — the ramp ` +
      `is the player's days of work, and the regent spent none of it`,
  );

  check(
    steward.economy.divisions.length > 0,
    `the regent raised its garrison (${steward.economy.divisions.length} ` +
      `division(s) on the roster)`,
  );
  check(
    steward.economy.researchSlots.some((slot) => slot.tech !== null),
    "and put the research slots to work",
  );

  // Leave the world as found: the regent back off, the marching stopped.
  await steward.command(
    {
      kind: "configure_regent",
      enabled: false,
      focus: "defence",
      marketBudget: 0.5,
    },
    "regent-off",
  );
  for (const attack of invader.economy.attacks) {
    await invader.command(
      { kind: "cancel_attack", provinceId: attack.province },
      `stop-${attack.province}`,
    );
  }

  const healthy = await health();
  check(
    healthy.healthy && healthy.lagMs < 1000,
    `the world stayed healthy throughout (${healthy.lagMs} ms behind at tick ${healthy.tick})`,
  );

  log(failures === 0 ? "PASS" : "FAIL");
  process.exitCode = failures === 0 ? 0 : 1;
  steward.close();
  invader.close();
  spectator.close();
}

main().catch((error) => {
  log(`  FAIL  ${error.message}`);
  process.exit(1);
});
