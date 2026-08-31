#!/usr/bin/env node
/**
 * The phase-5 gate: a completed tech measurably changes a production number.
 *
 * CLAUDE.md §8, phase 5, in one sentence — and the whole difficulty is in the
 * word *measurably*. Every number on this wire moves for reasons that have
 * nothing to do with research: the border drift takes a mine, the efficiency
 * ramp climbs a step, a shortage scales everything down. Watching
 * `outputPerTick` across a tech and calling the difference the tech is how a
 * gate passes for the wrong reason.
 *
 * So it measures the one thing the tech actually changes, isolated. The wire
 * carries a line's `factories`, `efficiency` and `outputPerTick`, and the
 * nation's `sufficiency`, and the server computes output as
 *
 *   outputPerTick = factories x perFactory x efficiency x sufficiency / cost
 *
 * so `perFactory` — the only term research touches — can be divided back out
 * of figures the wire already carries. `machine_tools` says +10% and the
 * number has to move by +10%, on the single tick the tech lands, with
 * everything else divided away.
 *
 * It needs a fast world, like phases 3 and 4: the tech is 480 ticks.
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase5-gate.mjs
 *   docker compose up -d
 *
 * And prove it can fail:
 *
 *   node scripts/phase5-gate.mjs --break=modifier  # the tech changes nothing
 *   node scripts/phase5-gate.mjs --break=jump      # progress arrives in a lump
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 9;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

const MESSAGE_TIMEOUT_MS = 300_000;

/** BUILDING_TYPES.length, for decoding the delta's building changes. */
const BUILDING_COUNT = 10;

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
 * The tech this gate measures, and what it claims to do.
 *
 * Restated from src/shared/config/techs.ts, like every other constant a .mjs
 * gate needs. `machine_tools` is chosen because it has no prerequisites and
 * because what it moves — the output of one factory — is the one term that can
 * be divided cleanly out of the figures on the wire.
 */
const TECH = "machine_tools";
const TECH_TICKS = 480;
const TECH_FACTORY_OUTPUT = 0.1;

/** MILITARY_FACTORY_OUTPUT in src/shared/config/rates.ts. */
const MILITARY_FACTORY_OUTPUT = 0.4;
/** EQUIPMENT.infantry_equipment.cost. */
const RIFLE_COST = 1;

const SETUP_BUDGET_MS = 60_000;
const RESEARCH_BUDGET_MS = 180_000;

function lineOf(economy, id) {
  return economy.productionLines.find((line) => line.id === id);
}

/**
 * What one factory on this line turns out per tick, with everything that is
 * not research divided back out.
 *
 * This is the whole measurement. `outputPerTick` moves when the drift takes a
 * mine (through `sufficiency`), when the ramp climbs (through `efficiency`)
 * and when a factory is added — none of which is the tech. Divide all three
 * away and what is left is `MILITARY_FACTORY_OUTPUT x (1 + research)`, which
 * is exactly and only the thing `machine_tools` claims to change.
 */
function perFactory(economy, lineId) {
  const line = lineOf(economy, lineId);
  if (line === undefined) return null;
  const divisor = line.factories * line.efficiency * economy.sufficiency;
  if (divisor <= 0) return null;
  return (line.outputPerTick * RIFLE_COST) / divisor;
}

async function createLine(player, equipment, idPrefix) {
  const before = new Set(player.economy.productionLines.map((l) => l.id));
  await player.require(
    { kind: "create_production_line", equipment },
    `${idPrefix}-create`,
  );
  await player.waitFor(
    (p) => p.economy.productionLines.some((l) => !before.has(l.id)),
    `the ${equipment} line to appear`,
    30_000,
  );
  return player.economy.productionLines.find((l) => !before.has(l.id)).id;
}

/** Whatever an earlier run left behind. The world is persistent, gates and all. */
async function sweep(player) {
  const lines = [...player.economy.productionLines];
  const busy = player.economy.researchSlots.filter((s) => s.tech !== null);
  if (lines.length === 0 && busy.length === 0) return;
  log(`  clearing ${lines.length} line(s) and ${busy.length} busy slot(s)`);
  for (const line of lines) {
    await player.command(
      { kind: "remove_production_line", lineId: line.id },
      `sweep-line-${line.id}`,
    );
  }
  player.economy.researchSlots.forEach((slot, index) => {
    if (slot.tech === null) return;
    void player.command(
      { kind: "cancel_research", slot: index },
      `sweep-slot-${index}`,
    );
  });
  await player.waitUntil(
    (p) =>
      p.economy.productionLines.length === 0 &&
      p.economy.researchSlots.every((s) => s.tech === null),
    "the old lines and slots to clear",
    30_000,
  );
}

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

  log("phase-5 gate");
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const health = await fetch(HEALTH_URL).then((r) => r.json());
  log(
    `  world ${health.worldId} at tick ${health.tick}, ${health.tickMs} ms a tick`,
  );
  if (health.tickMs > MAX_TICK_MS) {
    log("");
    log(`  This world ticks every ${health.tickMs} ms, and the tech this gate`);
    log(
      `  researches is ${TECH_TICKS} ticks. Bring the stack up with a faster`,
    );
    log("  clock and run it again:");
    log("");
    log("    WORLD_TICK_MS=50 docker compose up -d --build");
    log("    node scripts/phase5-gate.mjs");
    log("    docker compose up -d");
    log("");
    process.exit(2);
  }

  const spectator = new Player(null);
  await spectator.ready;
  const nation = largestNation(spectator.controllers);
  spectator.close();

  const player = new Player(nation);
  await player.ready;
  check(
    player.economy !== null,
    "a nation is sent its own economy; a spectator is not",
  );
  log(
    `  playing nation ${nation}: ${player.economy.researchSlots.length} slots ` +
      `on the wire, ${player.economy.researchSlots.filter((s) => s.unlocked).length} ` +
      `of them unlocked, ${player.economy.unlockedTechs.length} techs known`,
  );
  check(
    player.economy.researchSlots.some((slot) => slot.unlocked),
    "the nation has a research slot to work with",
  );

  await sweep(player);

  // Something for the tech to be measured against: one line, one factory, and
  // a nation that is not so short of steel that everything reads zero.
  const line = await createLine(player, "infantry_equipment", "rifles");
  await player.require(
    { kind: "assign_factories", lineId: line, factories: 1 },
    "assign",
  );
  const ready = await player.waitUntil(
    (p) => perFactory(p.economy, line) !== null,
    "the line to be producing something measurable",
    SETUP_BUDGET_MS,
  );
  check(ready, "the line is running, so there is a number to move");

  const before = perFactory(player.economy, line);
  log(
    `  one factory turns out ${before.toFixed(4)} a tick before any research`,
  );
  check(
    Math.abs(before - MILITARY_FACTORY_OUTPUT) < 1e-6,
    `and that is the base rate the config states, with efficiency, ` +
      `sufficiency and the factory count divided back out ` +
      `(${before.toFixed(4)} vs ${MILITARY_FACTORY_OUTPUT})`,
  );

  // The refusals on the way are the validation path being exercised for free.
  const wrong = await player.command(
    { kind: "start_research", slot: 0, tech: "deep_mining" },
    "prereq",
  );
  check(
    !wrong.accepted,
    `a tech whose prerequisites are missing is refused: ${wrong.reason}`,
  );

  const slot = player.economy.researchSlots.findIndex((s) => s.unlocked);
  const started = await player.require(
    { kind: "start_research", slot, tech: TECH },
    "start",
  );
  log(`  slot ${slot} starts ${TECH} on tick ${started.tick}`);

  // Invariant 1: it accrues, every tick, by a rate. Nothing arrives in a lump.
  let seen = 0;
  let jumps = 0;
  let previous = -1;
  let doneAt = null;
  const until = Date.now() + RESEARCH_BUDGET_MS;
  let lastTick = player.tick;
  while (Date.now() < until && doneAt === null) {
    await sleep(25);
    for (let tick = lastTick + 1; tick <= player.tick; tick++) {
      const economy = player.history.get(tick);
      if (economy === undefined) continue;
      lastTick = tick;
      if (economy.unlockedTechs.includes(TECH)) {
        doneAt = tick;
        break;
      }
      const progress = economy.researchSlots[slot].progress;
      if (progress === previous) continue;
      if (previous >= 0) {
        const step = progress - previous;
        if (step !== 1) jumps++;
        seen++;
      }
      previous = progress;
    }
  }

  check(seen > 50, `progress was seen moving on ${seen} separate ticks`);
  check(
    BREAK === "jump" ? false : jumps === 0,
    `and it moved by exactly one tick's work each time (${jumps} jumps)`,
  );
  check(doneAt !== null, `${TECH} finished on tick ${doneAt}`);
  if (doneAt === null) {
    log(`FAIL (${failures}) — the tech never finished`);
    process.exit(1);
  }

  check(
    player.economy.unlockedTechs.includes(TECH),
    `and the nation holds it: ${player.economy.unlockedTechs.join(", ")}`,
  );
  check(
    player.economy.researchSlots[slot].tech === null,
    "the slot is free again, ready for the next one",
  );

  // Measured across the single tick the tech landed on. The phase-3 gate
  // learned this the expensive way: a comparison spanning hundreds of ticks
  // says as much about what the border drift did as about what was measured.
  const justBefore = player.history.get(doneAt - 1);
  const justAfter = player.history.get(doneAt);
  check(
    justBefore !== undefined && justAfter !== undefined,
    `with the tick before it on record too (${doneAt - 1} and ${doneAt})`,
  );
  const wasPerFactory = perFactory(justBefore, line);
  const nowPerFactory =
    BREAK === "modifier" ? wasPerFactory : perFactory(justAfter, line);
  check(
    wasPerFactory !== null && nowPerFactory !== null,
    "and the line was measurable on both of them",
  );
  if (wasPerFactory !== null && nowPerFactory !== null) {
    const moved = nowPerFactory / wasPerFactory - 1;
    check(
      Math.abs(moved - TECH_FACTORY_OUTPUT) < 1e-6,
      `one factory now turns out ${nowPerFactory.toFixed(4)} a tick against ` +
        `${wasPerFactory.toFixed(4)} — ${(moved * 100).toFixed(1)}%, and the ` +
        `tech claims ${(TECH_FACTORY_OUTPUT * 100).toFixed(1)}%`,
    );
  }

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
