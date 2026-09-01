#!/usr/bin/env node
/**
 * The phase-4 gate: a sustained fight drains a stockpile and weakens units,
 * and switching a production line costs the player output for a long time.
 *
 * CLAUDE.md §8, phase 4, in full. Both halves are visible from outside the
 * process — the wire carries the stockpile, every line's efficiency and
 * output, and every division's strength — so like phase 3 and unlike phase 2
 * this gate covers its whole sentence.
 *
 * It needs a **fast world**, and more of one than phase 3 did. A nation starts
 * with a single military factory at the 10% efficiency floor, which is 0.04
 * equipment a tick; one division at full strength is 112 pieces. So the gate
 * has to build an industry before it has anything to destroy, and the whole
 * run is a few thousand ticks:
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase4-gate.mjs
 *   docker compose up -d          # back to a real world afterwards
 *
 * And prove it can fail. The first is the one that matters: it puts no
 * division on the frontier at all, so no clash can land on one, and the gate
 * has to notice that its subject never happened rather than finding a drain
 * somewhere else and calling it a fight.
 *
 *   node scripts/phase4-gate.mjs --break=quiet   # nothing on the frontier
 *   node scripts/phase4-gate.mjs --break=drain   # the fight destroys nothing
 *   node scripts/phase4-gate.mjs --break=reset   # a switch keeps its ramp
 *   node scripts/phase4-gate.mjs --break=lump    # watch the front only after the fact
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 14;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

const MESSAGE_TIMEOUT_MS = 300_000;

/** EQUIPMENT_TYPES.indexOf(...) in src/shared/economy/Equipment.ts. */
const INFANTRY_EQUIPMENT = 0;
const ARTILLERY = 1;

/** DIVISION_TEMPLATE in the same file: what one division is at full strength. */
const TEMPLATE = [
  [INFANTRY_EQUIPMENT, 100],
  [ARTILLERY, 12],
];

/**
 * The line between a clash and mere attrition, as a share of what a division
 * had.
 *
 * From phase 6 on, combat is no longer the only thing that takes equipment out
 * of a division: an under-supplied one wastes away at up to `SUPPLY_ATTRITION`
 * (0.02) of what it holds per tick, with no enemy anywhere near. A clash takes
 * `COMBAT_DEFENDER_LOSS` (0.08) or `COMBAT_ATTACKER_LOSS` (0.05). Half way
 * between the two separates them cleanly, and anything above the line still
 * has to be explained by a province changing hands — which is what keeps this
 * gate about the fight rather than about the supply lines.
 */
const CLASH_FLOOR = 0.04;

/** Everything one division is made of, as one number. */
const DIVISION_EQUIPMENT = TEMPLATE.reduce((sum, [, want]) => sum + want, 0);

/** BUILDING_TYPES.length, and buildingIndex("military_factory"). */
const BUILDING_COUNT = 10;
const MILITARY_FACTORY = 1;

/** EFFICIENCY_FLOOR, _CAP and _GAIN in src/shared/config/rates.ts. */
const EFFICIENCY_FLOOR = 0.1;
const EFFICIENCY_GAIN = 0.001;

/** TICKS_PER_DAY in src/shared/config/time.ts — invariant 9, output is per day. */
const TICKS_PER_DAY = 24;

/**
 * The march rate from shared/config/combat.ts, restated: the fastest step any
 * front may take in one tick. A step past this is a lump, not a rate.
 */
const FRONT_MAX_STEP = 1 / 8;

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
 * The province graph, from the artefact beside the terrain.
 *
 * Only the neighbour lists, and only to find this nation's *border* provinces:
 * a division standing in the interior is never in a clash, and eight divisions
 * scattered at random over forty provinces would have the gate waiting for a
 * front to wander past them. `provinces.json` carries the adjacency the server
 * loads from the same directory (decision 0006), so reading it here is reading
 * the map, not reimplementing it.
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

/** Provinces this nation owns *and* holds, with a neighbour in someone else's hand. */
function borderProvinces(player, neighbours) {
  const found = [];
  for (let province = 0; province < player.controllers.length; province++) {
    if (player.controllers[province] !== player.nation) continue;
    if (player.owners[province] !== player.nation) continue;
    const adjacent = neighbours.get(province) ?? [];
    if (
      adjacent.some(
        (n) =>
          player.controllers[n] !== player.nation &&
          player.controllers[n] !== 0,
      )
    ) {
      found.push(province);
    }
  }
  return found;
}

/** And the opposite: nothing foreign anywhere near it. The control division. */
function interiorProvinces(player, neighbours) {
  const found = [];
  for (let province = 0; province < player.controllers.length; province++) {
    if (player.controllers[province] !== player.nation) continue;
    if (player.owners[province] !== player.nation) continue;
    const adjacent = neighbours.get(province) ?? [];
    if (adjacent.length === 0) continue;
    if (
      adjacent.every(
        (n) =>
          player.controllers[n] === player.nation ||
          player.controllers[n] === 0,
      )
    ) {
      found.push(province);
    }
  }
  return found;
}

/**
 * Put a building somewhere this nation can actually build it.
 *
 * Lifted from the phase-3 gate, including the reason it tries `preferred`
 * first: every probe is a command and every command waits for its ack, so
 * walking forty provinces per attempt is forty ticks spent asking a question
 * that had the same answer last time.
 */
async function queueSomewhere(player, building, idPrefix, preferred = -1) {
  let refused = 0;
  const order = [preferred];
  for (let province = 0; province < player.controllers.length; province++) {
    if (province !== preferred) order.push(province);
  }
  for (const province of order) {
    if (province < 0) continue;
    if (player.controllers[province] !== player.nation) continue;
    if (player.owners[province] !== player.nation) continue;
    const ack = await player.command(
      { kind: "queue_construction", provinceId: province, building },
      `${idPrefix}-${province}`,
    );
    if (ack.accepted) return { province, refused };
    refused++;
  }
  throw new Error(
    `nowhere would take a ${building} (${refused} provinces refused)`,
  );
}

/**
 * The two equipment types a division is made of, in the stockpile.
 *
 * `--break=drain` freezes this at the first reading, which is what a world
 * whose fight cost it nothing would look like from outside. The check that has
 * to notice is "the fight spent the warehouse".
 */
let frozenStock = null;
function templateStock(economy) {
  const real =
    economy.stockpile[INFANTRY_EQUIPMENT] + economy.stockpile[ARTILLERY];
  if (BREAK !== "drain") return real;
  frozenStock ??= real;
  return frozenStock;
}

/** How many divisions this stockpile could bring to full strength. */
function equippableFrom(economy) {
  return Math.min(
    ...TEMPLATE.map(([index, want]) =>
      Math.floor(economy.stockpile[index] / want),
    ),
  );
}

function totalStrength(economy) {
  return economy.divisions.reduce((sum, d) => sum + d.strength, 0);
}

function lineOf(economy, id) {
  return economy.productionLines.find((line) => line.id === id);
}

/**
 * Open a line and find out what it was called.
 *
 * The ack says "accepted for tick N", not "and its id is 3" — ids are handed
 * out by the reducer so that a replay hands out the same ones (the same
 * reasoning as construction order ids, and the same bug that taught it). So
 * the id is read off the wire on the tick the line appears.
 */
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

/**
 * Clear out whatever the last run of this gate left behind.
 *
 * **The world is persistent, and that includes the gate's own mess.** Postgres
 * has a named volume and the world restores on startup, so a second run
 * inherits the first run's production lines — and is then refused, because
 * those lines still hold the factories it wants (`MAX_PRODUCTION_LINES` and
 * the `assign_factories` check in World.ts). The first version of this gate
 * passed once and then failed twice in a row with
 * "you hold 6 military factories, 4 of them already on other lines", which
 * reads like a finding and is nothing but leftovers.
 *
 * Divisions go too. Their manpower does **not** come back — "the men do not
 * come back" is the rule, not an oversight — so a back-to-back run has less to
 * spend than the one before it. The gate says so rather than stalling on
 * refused `raise_division`s.
 */
async function sweep(player) {
  const lines = [...player.economy.productionLines];
  const divisions = [...player.economy.divisions];
  if (lines.length === 0 && divisions.length === 0) return;
  log(
    `  clearing ${lines.length} production line(s) and ${divisions.length} ` +
      `division(s) left by an earlier run`,
  );
  for (const line of lines) {
    await player.command(
      { kind: "remove_production_line", lineId: line.id },
      `sweep-line-${line.id}`,
    );
  }
  for (const division of divisions) {
    await player.command(
      { kind: "disband_division", divisionId: division.id },
      `sweep-div-${division.id}`,
    );
  }
  await player.waitUntil(
    (p) =>
      p.economy.productionLines.length === 0 &&
      p.economy.divisions.length === 0,
    "the old lines and divisions to go",
    30_000,
  );
}

/**
 * Put as many factories on a line as the nation can actually spare, right now.
 *
 * Not `require`: the border drift moves a province every tick, and a province
 * with a factory in it can be gone between counting the factories and asking
 * for them. That is the world working, not the command failing, so the gate
 * asks for what is left rather than dying — and returns the number it got, so
 * every later sum is the truth rather than the plan.
 */
async function assignUpTo(player, lineId, want, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const yardTotal = player.economy.militaryFactoriesTotal;
    const elsewhere = player.economy.productionLines
      .filter((line) => line.id !== lineId)
      .reduce((sum, line) => sum + line.factories, 0);
    const possible = Math.max(0, Math.min(want, yardTotal - elsewhere));
    if (possible === 0) break;

    const ack = await player.command(
      { kind: "assign_factories", lineId, factories: possible },
      `${id}-${attempt}`,
    );
    if (!ack.accepted) {
      log(`  assign_factories(${possible}) refused: ${ack.reason}`);
      want = possible - 1;
      continue;
    }
    // An accepted command is not an applied one. World.ts revalidates at apply
    // time and skips silently what no longer holds, so a province with a
    // factory in it changing hands in the intervening tick leaves an "accepted"
    // ack and a line with nothing on it. Believe the wire, and if the wire
    // disagrees, ask for less rather than returning zero without a word — a
    // production line that quietly never ran is the most expensive way for a
    // gate to fail, because everything downstream then measures nothing.
    const applied = await player.waitUntil(
      (p) => (lineOf(p.economy, lineId)?.factories ?? -1) === possible,
      `line ${lineId} to hold ${possible} factories`,
      20_000,
    );
    if (applied) return possible;
    log(
      `  line ${lineId} did not take ${possible} factories; the nation now ` +
        `holds ${player.economy.militaryFactoriesTotal}. Trying for fewer.`,
    );
    want = possible - 1;
  }
  return lineOf(player.economy, lineId)?.factories ?? 0;
}

// ---------------------------------------------------------------------------
// Budgets. Every wait in this gate is bounded, and running out of time is an
// answer: the phase-3 gate spent a quarter of an hour in a build loop because
// against a world whose borders move every tick there is always one more
// province to try. Measure the world you have.
// ---------------------------------------------------------------------------

/** Military factories to build before there is an industry worth destroying. */
const TARGET_FACTORIES = 6;
/** Of those, how many make artillery; the rest make rifles. */
const ARTILLERY_FACTORIES = 2;
const BUILD_UP_BUDGET_MS = 240_000;
const PER_BUILDING_TIMEOUT_MS = 45_000;
const MAX_STALLED = 6;

/** Efficiency the ramp must reach before a switch has anything to take away. */
const RAMP_TARGET = 0.35;
/**
 * Long, because artillery is the slow half and it is the one that counts.
 *
 * A division is 100 rifles and 12 guns, and a gun is four industrial points
 * against a rifle's one — so two factories on guns fill a division's artillery
 * about as fast as four on rifles fill its infantry, and any drift from that
 * split shows up here as the gate waiting. It measures the world it has when
 * the budget runs out rather than waiting for the one it wanted.
 */
const RAMP_BUDGET_MS = 300_000;

/** Divisions to raise, at most. Each costs DIVISION_MANPOWER. */
const MAX_RAISED = 12;
/** How long to let the front grind before measuring what it did. */
const FIGHT_BUDGET_MS = 240_000;
/** Below this the template stockpile counts as spent. */
const EMPTY_STOCK = 5;

async function main() {
  let failures = 0;
  const check = (ok, message) => {
    log(`${ok ? "  ok  " : "  FAIL"}  ${message}`);
    if (ok) return;
    failures++;
    // A counter-proof asks one question, and the answer arrives with the first
    // FAIL. Running on afterwards costs minutes and tells nobody anything.
    if (BREAK !== null) {
      log(`FAIL (${failures}) — stopped at the first failure, as intended`);
      process.exit(1);
    }
  };

  log("phase-4 gate");
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const health = await fetch(HEALTH_URL).then((r) => r.json());
  log(
    `  world ${health.worldId} at tick ${health.tick}, ${health.tickMs} ms a tick`,
  );
  if (health.tickMs > MAX_TICK_MS) {
    log("");
    log(`  This world ticks every ${health.tickMs} ms. This gate builds an`);
    log("  industry, ramps a production line for several hundred ticks and");
    log("  then grinds a front — hours, at that rate. Bring the stack up with");
    log("  a faster clock and run it again:");
    log("");
    log("    WORLD_TICK_MS=50 docker compose up -d --build");
    log("    node scripts/phase4-gate.mjs");
    log("    docker compose up -d");
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
  const held = player.controllers.filter((c) => c === nation).length;
  log(
    `  playing nation ${nation}: ${held} provinces, ` +
      `${player.economy.militaryFactoriesTotal} military factories, ` +
      `${Math.floor(player.economy.manpower)}/${Math.floor(player.economy.manpowerCap)} manpower`,
  );
  await sweep(player);

  // -------------------------------------------------------------------------
  // Setup: an industry worth destroying.
  //
  // A nation starts with one military factory at the 10% floor, which is 0.04
  // equipment a tick against a division that wants 112 pieces. Nothing in
  // §8's sentence is observable until that is fixed, so the gate does what a
  // player would: it builds.
  // -------------------------------------------------------------------------
  log("  building an industry...");
  let stalled = 0;
  let lastGoodProvince = -1;
  const buildUpUntil = Date.now() + BUILD_UP_BUDGET_MS;
  while (
    player.economy.militaryFactoriesTotal < TARGET_FACTORIES &&
    Date.now() < buildUpUntil
  ) {
    const order = await queueSomewhere(
      player,
      "military_factory",
      `mil-${player.economy.militaryFactoriesTotal}`,
      lastGoodProvince,
    );
    lastGoodProvince = order.province;

    // An accepted command takes effect on the *next* tick, so the queue is
    // still empty the moment the ack arrives. Wait for the thing to appear
    // before waiting for it to be gone.
    await player.waitFor(
      (p) => p.economy.queue.length > 0,
      `the order for province ${order.province} to reach the queue`,
    );
    const at = order.province * BUILDING_COUNT + MILITARY_FACTORY;
    const had = player.buildings[at];
    const finished = await player.waitUntil(
      (p) => p.buildings[at] > had,
      `a military factory in province ${order.province}`,
      PER_BUILDING_TIMEOUT_MS,
    );
    if (finished) {
      log(
        `  factory ${player.economy.militaryFactoriesTotal} ` +
          `in province ${order.province}`,
      );
      continue;
    }
    // Almost always because the province changed hands underneath it. A
    // queued order whose province has been lost waits, by design; the gate
    // cannot.
    log(`  province ${order.province} stalled; cancelling and moving on`);
    await player.command(
      { kind: "cancel_construction", orderId: player.economy.queue[0]?.id },
      `drop-${stalled}`,
    );
    lastGoodProvince = -1;
    if (++stalled > MAX_STALLED) {
      throw new Error(`${stalled} builds stalled; this world is too unstable`);
    }
  }
  const factories = player.economy.militaryFactoriesTotal;
  log(`  ${factories} military factories`);

  // Two lines, because a division is rifles *and* guns: strength is the worst
  // ratio across the template (§6.3), so a nation with a warehouse of rifles
  // and no artillery has divisions at zero.
  const artilleryFactories = Math.min(ARTILLERY_FACTORIES, factories - 1);
  const rifleFactories = factories - artilleryFactories;
  const rifleLine = await createLine(player, "infantry_equipment", "rifles");
  const gunLine = await createLine(player, "artillery", "guns");
  const gunsOn = await assignUpTo(
    player,
    gunLine,
    artilleryFactories,
    "assign-guns",
  );
  const riflesOn = await assignUpTo(
    player,
    rifleLine,
    rifleFactories,
    "assign-rifles",
  );
  check(
    riflesOn > 0 && gunsOn > 0,
    `line ${rifleLine} makes rifles on ${riflesOn} factories, ` +
      `line ${gunLine} makes guns on ${gunsOn}`,
  );

  // The ramp and the stockpile grow together: the same ticks that climb the
  // efficiency curve are the ticks that fill the warehouse half A empties.
  log("  ramping the line and filling the stockpile...");
  // Wait for what the gate actually needs, which is **divisions it can
  // equip** — not for a total. A division is the worst ratio across its
  // template (§6.3), so a warehouse of two and a half thousand rifles and
  // twelve guns equips one division, and a gate that waited on the sum
  // stopped there and had nothing to fight with. Artillery is four industrial
  // points a piece against a rifle's one, so it is almost always the binding
  // half and it is the one worth waiting for.
  const DIVISIONS_WANTED = 4;
  await player.waitUntil(
    (p) =>
      equippableFrom(p.economy) >= DIVISIONS_WANTED &&
      (lineOf(p.economy, rifleLine)?.efficiency ?? 0) >= RAMP_TARGET,
    "the ramp and enough equipment for a few divisions",
    RAMP_BUDGET_MS,
  );
  for (const line of player.economy.productionLines) {
    log(
      `  line ${line.id}: ${line.equipment} on ${line.factories} ` +
        `factories at ${(line.efficiency * 100).toFixed(1)}%, ` +
        `${line.outputPerTick.toFixed(3)} a tick`,
    );
  }
  log(
    `  stockpile ${player.economy.stockpile[INFANTRY_EQUIPMENT].toFixed(0)} rifles ` +
      `and ${player.economy.stockpile[ARTILLERY].toFixed(0)} guns — ` +
      `${equippableFrom(player.economy)} division(s) worth, at ` +
      `${(player.economy.sufficiency * 100).toFixed(0)}% sufficiency`,
  );

  // -------------------------------------------------------------------------
  // Half B, first part: moving factories does not reset the ramp.
  //
  // §6.2 has two halves and this is the one nobody remembers: *adding or
  // removing factories from a line does not reset it*. Only the type does. A
  // gate that only checked the reset would pass against an implementation
  // that reset on everything, which would make the game unplayable in the
  // opposite direction.
  // -------------------------------------------------------------------------
  // Only meaningful with a factory to spare: stripping a one-factory line
  // leaves it idle, and an idle line *decays* (rates.ts, EFFICIENCY_DECAY) —
  // which is the rule working, not the rule broken, and would fail this check
  // for the wrong reason.
  const onLine = lineOf(player.economy, rifleLine).factories;
  if (onLine < 2) {
    log("  only one factory on the line; skipping the factory-move check");
  } else {
    const beforeMove = lineOf(player.economy, rifleLine).efficiency;
    // Not `require`. A province with a factory in it can change hands between
    // counting the factories and asking for them, and the command is then
    // refused for a reason that has nothing to do with §6.2. That is the world
    // working; the gate says so and moves on rather than dying on it.
    const moveAck = await player.command(
      { kind: "assign_factories", lineId: rifleLine, factories: onLine - 1 },
      "move-out",
    );
    const moved = moveAck.accepted
      ? await player.waitUntil(
          (p) => lineOf(p.economy, rifleLine)?.factories === onLine - 1,
          "the factory to leave",
          20_000,
        )
      : false;
    if (!moved) {
      log("  the line lost factories to the drift; skipping the move check");
    } else {
      await player.command(
        { kind: "assign_factories", lineId: rifleLine, factories: onLine },
        "move-back",
      );
      await player.waitUntil(
        (p) => lineOf(p.economy, rifleLine)?.factories === onLine,
        "it to come back",
        20_000,
      );
      let lowestOverMove = Infinity;
      for (let tick = moveAck.tick; tick <= player.tick; tick++) {
        const line = lineOf(
          player.history.get(tick) ?? { productionLines: [] },
          rifleLine,
        );
        if (line !== undefined)
          lowestOverMove = Math.min(lowestOverMove, line.efficiency);
      }
      check(
        lowestOverMove >= beforeMove - 1e-9,
        `taking a factory off the line and putting it back left the ramp alone ` +
          `(${(beforeMove * 100).toFixed(1)}% -> never below ${(lowestOverMove * 100).toFixed(1)}%)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Half B, second part: switching throws the ramp away.
  // -------------------------------------------------------------------------
  const earned = lineOf(player.economy, rifleLine).efficiency;
  const earnedOutput = lineOf(player.economy, rifleLine).outputPerTick;
  // Without this, "switching knocked it back to the floor" passes against a
  // line that was sitting on the floor all along — with no factories, or with
  // sufficiency at zero. There has to be a ramp before there is a loss.
  check(
    earned >= RAMP_TARGET,
    `the line climbed to ${(earned * 100).toFixed(1)}% before anything was ` +
      `taken from it`,
  );
  const switchAck = await player.require(
    { kind: "switch_production_line", lineId: rifleLine, equipment: "fighter" },
    "switch",
  );
  await player.waitFor(
    (p) => p.history.has(switchAck.tick) && p.tick > switchAck.tick,
    "the switch to land",
  );
  const switched = lineOf(player.history.get(switchAck.tick), rifleLine);
  // A reset observed in the same tick is not a reset *to* the floor: commands
  // apply before the systems run, so the line is knocked back and then climbs
  // one step before anything can look at it. "At most floor plus one gain" is
  // the honest statement of the rule.
  const afterSwitch = BREAK === "reset" ? earned : switched.efficiency;
  check(
    afterSwitch <= EFFICIENCY_FLOOR + EFFICIENCY_GAIN + 1e-9,
    `switching the line threw the ramp away: ` +
      `${(earned * 100).toFixed(1)}% -> ${(afterSwitch * 100).toFixed(1)}% ` +
      `on tick ${switchAck.tick}`,
  );
  check(
    switched.equipment === "fighter",
    `and the line makes fighters now, not rifles`,
  );

  // -------------------------------------------------------------------------
  // Half A: a sustained fight drains a stockpile and weakens units.
  //
  // Divisions go into *border* provinces, because the border clash only
  // touches the two provinces it moves between. Then every source of template
  // equipment is switched off — the rifle line already makes fighters, and the
  // artillery line is stood down — so that from here on the only thing that
  // can move a division's strength downwards is combat, and the only thing
  // that can move the stockpile upwards is nothing at all.
  // -------------------------------------------------------------------------
  const gunsOff = await player.require(
    { kind: "assign_factories", lineId: gunLine, factories: 0 },
    "guns-off",
  );
  await player.waitFor(
    (p) => p.tick > gunsOff.tick,
    "the artillery line to stand down",
  );
  // The high-water mark: what the nation held the moment the last thing that
  // could make a rifle or a gun stopped. Everything after this is spending.
  const stockAtStop = templateStock(player.economy);

  const borders = borderProvinces(player, neighbours);
  const affordable = Math.floor(player.economy.manpower / 1000);
  const equippable = equippableFrom(player.economy);
  const wanted = Math.min(MAX_RAISED, borders.length, affordable, equippable);
  log(
    `  ${borders.length} border provinces, manpower for ${affordable} divisions, ` +
      `equipment for ${equippable}; raising ${wanted}`,
  );
  // The control. One division in a province with nothing foreign anywhere
  // near it: it draws from the same stockpile, is reinforced by the same
  // system, and is never in a clash. **Its strength must never fall, on any
  // tick of the run.** If it does, something other than combat is destroying
  // equipment, and every other check in this half is measuring that instead.
  let quiet = null;
  const interior = interiorProvinces(player, neighbours);
  for (const province of interior) {
    const ack = await player.command(
      { kind: "raise_division", provinceId: province },
      `control-${province}`,
    );
    if (!ack.accepted) continue;
    await player.waitUntil(
      (p) => p.economy.divisions.length > 0,
      "the control division to appear",
      20_000,
    );
    quiet = player.economy.divisions[player.economy.divisions.length - 1].id;
    log(
      `  control division ${quiet} in province ${province}, well behind the line`,
    );
    break;
  }

  // The counter-proof for the whole of half A: with nothing on the frontier,
  // no clash can land on a division, and the gate has to say so rather than
  // find a drain somewhere else and call it a fight.
  if (BREAK === "quiet")
    log("  --break=quiet: raising nothing on the frontier");
  let raised = 0;
  for (const province of borders) {
    if (BREAK === "quiet") break;
    if (raised >= wanted) break;
    const ack = await player.command(
      { kind: "raise_division", provinceId: province },
      `raise-${province}`,
    );
    if (!ack.accepted) continue;
    // raise_division does not count the tick's own pending commands the way
    // queue_construction does, so two in one tick can both be acked and only
    // one applied. Watch the roster, not the ack.
    await player.waitUntil(
      (p) => p.economy.divisions.length > raised + (quiet === null ? 0 : 1),
      `division ${raised + 1} to appear`,
      20_000,
    );
    raised = player.economy.divisions.length - (quiet === null ? 0 : 1);
  }
  check(
    BREAK === "quiet" || raised >= 2,
    `raised ${raised} divisions on the frontier` +
      (quiet === null ? "" : ", and one behind it as a control"),
  );
  // **The fight has to be started.** Until the border drift was replaced by
  // §6.9 (decision 0014) this gate raised divisions along a border and waited
  // for the world's own heartbeat to walk into them. Nothing moves on its own
  // any more, and that is the point of the change — so the gate starts a war,
  // which is what the sentence in §8 was always describing.
  //
  // A real one, with somebody on the other side: an attack on empty ground is
  // taken on the first tick and costs one tick of losses. So a second nation
  // is connected, garrisons the province being attacked, and the front then
  // grinds every tick — the attacker paying `ATTACKER_LOSS` and the defender
  // `DEFENDER_LOSS` of what their engaged divisions hold, for as long as the
  // order stands.
  const attackedProvinces = [];
  let firstAttackTick = Infinity;
  let defenderPlayer = null;
  if (BREAK !== "quiet") {
    const stations = player.economy.divisions
      .filter((division) => division.id !== quiet)
      .map((division) => division.provinceId);
    for (const from of stations) {
      const target = (neighbours.get(from) ?? []).find(
        (province) =>
          player.controllers[province] !== nation &&
          player.controllers[province] !== 0,
      );
      if (target === undefined) continue;
      const foe = player.controllers[target];

      if (defenderPlayer === null) {
        defenderPlayer = new Player(foe);
        await defenderPlayer.ready;
        const garrison = await defenderPlayer.command(
          { kind: "raise_division", provinceId: target },
          `garrison-${target}`,
        );
        if (!garrison.accepted) {
          log(
            `  nation ${foe} cannot garrison province ${target}: ${garrison.reason}`,
          );
          defenderPlayer.close();
          defenderPlayer = null;
          continue;
        }
        await defenderPlayer.waitUntil(
          (p) => p.economy.divisions.some((d) => d.provinceId === target),
          `nation ${foe} to garrison province ${target}`,
          20_000,
        );
        log(`  nation ${foe} garrisons province ${target}: there is a war now`);
      }

      const ack = await player.command(
        { kind: "claim_province", provinceId: target },
        `attack-${target}`,
      );
      if (ack.accepted) {
        attackedProvinces.push(target);
        firstAttackTick = Math.min(firstAttackTick, ack.tick);
      }
    }
  }
  check(
    BREAK === "quiet" || attackedProvinces.length > 0,
    `${attackedProvinces.length} standing attack(s) ordered on the frontier`,
  );

  log("  letting them draw what there is, then watching the front...");
  // Either they are full or the warehouse is empty — whichever comes first.
  // Waiting only for "empty" burned two minutes against a world whose earlier
  // gate runs had left twenty-five thousand rifles lying about: the divisions
  // filled in seconds and the stockpile was never going to run out.
  await player.waitUntil(
    (p) =>
      templateStock(p.economy) < EMPTY_STOCK ||
      p.economy.divisions.every((d) => d.strength > 0.99),
    "the divisions to fill or the stockpile to run out",
    FIGHT_BUDGET_MS / 2,
  );

  // From here the accounting is closed: nothing produces rifles or guns, so
  // the stockpile can only fall, and a division's strength can only fall.
  let lastTick = player.tick;
  const baseStrength = totalStrength(player.economy);
  const baseStock = templateStock(player.economy);
  const strengths = new Map(
    player.economy.divisions.map((d) => [d.id, d.strength]),
  );
  // Where each division is standing. Frozen with the roster: a division cannot
  // move in phase 4, and one whose province is taken simply stays there,
  // stranded, in a province somebody else now holds.
  const stationed = new Map(
    player.economy.divisions.map((d) => [d.id, d.provinceId]),
  );
  let clashTicks = 0;
  let lastStock = baseStock;

  let quietFell = 0;
  let unexplained = 0;
  let stockRose = 0;
  let recoveryTicks = null;
  let peakStock = baseStock;

  const fightUntil =
    Date.now() + (BREAK === null ? FIGHT_BUDGET_MS : FIGHT_BUDGET_MS / 6);
  while (Date.now() < fightUntil) {
    await sleep(25);
    for (let tick = lastTick + 1; tick <= player.tick; tick++) {
      const economy = player.history.get(tick);
      if (economy === undefined) continue;
      lastTick = tick;

      // Reinforcement only ever adds to a division, and combat only ever
      // takes away. So a tick on which any division got weaker is a tick the
      // front cost this nation something — an exact attribution, with no
      // second measurement needed.
      let fell = false;
      const moved = player.clashes.get(tick);
      for (const division of economy.divisions) {
        const was = strengths.get(division.id);
        strengths.set(division.id, division.strength);
        if (was === undefined || division.strength >= was - 1e-9) continue;
        // Attrition is a fall too, from phase 6 on, and a small one. Only a
        // fall big enough to be a clash counts as one — and only those have to
        // be explained by a province moving.
        if (was - division.strength <= was * CLASH_FLOOR) continue;
        if (division.id === quiet) quietFell++;
        else fell = true;

        // Nothing in this game takes equipment out of a division except
        // attrition and the front, so a division that got weaker by more than
        // attrition has to be **in the fight**: staged next to a province this
        // nation is attacking, or standing in one that changed hands this
        // tick. A fall anywhere else is something the gate does not
        // understand, and it would be measuring that instead of the war.
        const at = stationed.get(division.id);
        let near = false;
        if (at !== undefined) {
          near = (neighbours.get(at) ?? []).some((n) =>
            attackedProvinces.includes(n),
          );
          if (!near && moved !== undefined) {
            if (moved.has(at)) near = true;
            else near = (neighbours.get(at) ?? []).some((n) => moved.has(n));
          }
        }
        if (!near) unexplained++;
      }
      // **Or the warehouse paid instead.** A division whose losses are made
      // good the same tick shows no net fall at all — `reinforce` hands out a
      // share of every division's shortfall every tick, and a stockpile with
      // six thousand rifles in it replaces a five-percent loss before anybody
      // can see it. With production stopped, equipment can only leave the
      // warehouse to replace what the front destroyed, so a stockpile that
      // fell is a tick the war cost this nation something. That is §8's own
      // sentence — "a sustained fight visibly drains a stockpile" — and it is
      // what the drift used to make visible in rarer, larger steps.
      const stock = templateStock(economy);
      //
      // **Only while there is a war**, which `--break=quiet` proved the hard
      // way: with nothing on the frontier this counted the leftover divisions
      // of an earlier run topping themselves up, and the counter-proof passed
      // when it had to fail. A warehouse that empties is evidence of a fight
      // only if a fight was ordered.
      const drained = attackedProvinces.length > 0 && stock < lastStock - 1e-9;
      lastStock = stock;
      if (fell || drained) clashTicks++;

      if (stock > peakStock + 1e-6) stockRose++;
      peakStock = Math.max(peakStock, stock);

      const line = lineOf(economy, rifleLine);
      if (
        recoveryTicks === null &&
        line !== undefined &&
        line.efficiency >= earned
      ) {
        recoveryTicks = tick - switchAck.tick;
      }
    }
    if (clashTicks >= 8 && totalStrength(player.economy) < baseStrength) break;
  }

  const endStrength = totalStrength(player.economy);
  const endStock = templateStock(player.economy);

  check(
    clashTicks > 0,
    clashTicks > 0
      ? `the front cost this nation equipment on ${clashTicks} separate ` +
          `ticks, in steps too big to be supply attrition`
      : `no clash ever landed on a division, so nothing here was exercised`,
  );
  // The load-bearing attribution, and what makes this half mean "the fight did
  // it" rather than "something did it". A division standing where nothing
  // happened must come out of the tick no weaker than it went in.
  check(
    unexplained === 0,
    `every one of those losses was a province changing hands under the ` +
      `division that took it — ${unexplained} were not`,
  );
  if (quiet !== null) {
    log(
      `  the control division behind the line lost equipment on ${quietFell} ` +
        `tick(s); the drift can walk the front onto it, which is why the ` +
        `check above is the attribution and not its silence`,
    );
  }

  // Invariant 1 on the front itself: a province is taken as a rate the wire
  // shows moving, never as a lump. Walked out of the tick history the client
  // already keeps rather than sampled live, because the marches into empty
  // ground are over in eight ticks — 0.4 seconds at this clock — and the
  // first version of this check started watching after the fill-up wait and
  // saw nothing but the completions.
  //
  // `--break=lump` watches the way the pre-rate client would have: it looks
  // only at the completions, so it never sees a value between 0 and 1 and
  // the largest step it records is one whole province. The largest tolerated
  // step is the march rate — the fastest the config lets any front move.
  {
    const watched = [...new Set(attackedProvinces)];
    const last = new Map(watched.map((target) => [target, 0]));
    const fell = new Set();
    let between = 0;
    let biggest = 0;
    for (let tick = firstAttackTick; tick <= lastTick; tick++) {
      const economy = player.history.get(tick);
      if (economy === undefined) continue;
      for (const target of watched) {
        if (fell.has(target)) continue;
        const attack = economy.attacks.find((a) => a.province === target);
        if (attack !== undefined) {
          if (BREAK === "lump") continue;
          if (attack.progress > 0 && attack.progress < 1) between++;
          biggest = Math.max(biggest, attack.progress - last.get(target));
          last.set(target, attack.progress);
        } else if (player.clashes.get(tick)?.has(target)) {
          // The order is spent on the tick the province moved: it completed.
          // The final step is whatever lay between the last reading and 1 —
          // which is how a server that lumps the whole province into the
          // closing tick gets caught even if every earlier step was small.
          fell.add(target);
          biggest = Math.max(biggest, 1 - last.get(target));
        }
      }
    }
    check(
      BREAK === "quiet" || (between >= 8 && biggest <= FRONT_MAX_STEP + 1e-9),
      `the front moved gradually: progress was seen strictly between 0 and 1 ` +
        `on ${between} reading(s), and the largest one-tick step was ` +
        `${biggest.toFixed(3)} against a march rate of ${FRONT_MAX_STEP}`,
    );
    check(
      BREAK === "quiet" || fell.size > 0,
      `and a front completed: ${fell.size} of ${watched.length} attacked ` +
        `province(s) fell while the gate watched`,
    );
  }
  check(
    endStrength < baseStrength - 1e-9,
    `division strength fell while it ground on: ` +
      `${baseStrength.toFixed(3)} -> ${endStrength.toFixed(3)} ` +
      `across ${player.economy.divisions.length} divisions`,
  );
  // §6.3: combat losses *destroy* equipment. A war that recycled its own
  // materiel would have no economic footprint at all (invariant 6), and this
  // is the check that says it does not.
  check(
    stockRose === 0,
    `and the rifles and guns it destroyed never came back — with nothing ` +
      `being produced the stockpile only ever fell (${stockAtStop.toFixed(0)} ` +
      `-> ${endStock.toFixed(1)}, ${stockRose} rises)`,
  );
  // Measured against a division rather than against the warehouse. This world
  // is persistent and so is its stockpile: an earlier run of this gate left
  // twenty-five thousand rifles in it, and "spent half the warehouse" was then
  // a statement about that history rather than about this fight. What the
  // fight has to show is that it cost more equipment than a whole division is
  // made of — true on a nation with a full warehouse and on one with nothing.
  const spent = stockAtStop - endStock;
  check(
    spent > DIVISION_EQUIPMENT,
    `and replacing what it destroyed cost ${spent.toFixed(0)} rifles and guns ` +
      `out of the warehouse — more than the ${DIVISION_EQUIPMENT} a whole ` +
      `division is made of`,
  );

  // Half B's other half: how long the switch costs. Reported in in-game days,
  // per invariant 9 — the player never sees a tick count.
  if (recoveryTicks === null) {
    const now = lineOf(player.economy, rifleLine)?.efficiency ?? 0;
    const remaining = Math.ceil((earned - now) / EFFICIENCY_GAIN);
    log(
      `  the switched line is back to ${(now * 100).toFixed(1)}% of ` +
        `${(earned * 100).toFixed(1)}%, about ${(remaining / TICKS_PER_DAY).toFixed(1)} ` +
        `in-game days short`,
    );
    check(
      player.tick - switchAck.tick > 100 && now < earned,
      `switching cost output for the whole ${((player.tick - switchAck.tick) / TICKS_PER_DAY).toFixed(1)} ` +
        `in-game days this gate watched, and had not been paid back`,
    );
  } else {
    check(
      recoveryTicks > 100,
      `getting back to ${(earned * 100).toFixed(1)}% took ${recoveryTicks} ticks — ` +
        `${(recoveryTicks / TICKS_PER_DAY).toFixed(1)} in-game days of lost output`,
    );
  }
  log(
    `  for reference, the line made ${(earnedOutput * TICKS_PER_DAY).toFixed(2)} ` +
      `rifles a day before the switch`,
  );

  // And the world was never behind its own clock while all that happened. A
  // gate that passes against a world falling further behind every tick has
  // measured the wrong thing.
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
