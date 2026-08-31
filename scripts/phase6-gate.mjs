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
function hopsFromHome(player, neighbours, capitals, nation) {
  const depth = new Map();
  const queue = [...capitals];
  for (const capital of capitals) depth.set(capital, 0);
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head];
    for (const next of neighbours.get(here) ?? []) {
      if (depth.has(next)) continue;
      // **Controlled, not owned.** The server's own search conducts supply
      // over ground the nation holds; ownership follows a fortnight later
      // (decision 0002). Requiring both here found seven provinces on a world
      // four thousand ticks old, where almost everything held is still
      // occupied territory — the gate failing rather than the world, which is
      // the most expensive way for a gate to fail.
      if (player.controllers[next] !== nation) continue;
      depth.set(next, (depth.get(here) ?? 0) + 1);
      queue.push(next);
    }
  }
  return depth;
}

/**
 * A nation deep enough to have a supply problem at all.
 *
 * Not simply the largest: a wide, shallow nation has every province within a
 * hop of a capital and nothing this gate can measure. Wanted is one with
 * provinces it *owns* — `raise_division` needs that — several hops out.
 */
function deepestNation(player, neighbours, provinces) {
  let best = null;
  const deposits = provinces.deposits;
  for (let nation = 1; nation <= provinces.nations; nation++) {
    const capitals = provinces.capitals.filter(
      (id) => player.controllers[id] === nation && player.owners[id] === nation,
    );
    if (capitals.length === 0) continue;
    const depth = hopsFromHome(player, neighbours, capitals, nation);
    const usable = [...depth.entries()].filter(
      ([id]) => player.owners[id] === nation,
    );
    if (usable.length < 4) continue;
    const furthest = usable.reduce((a, b) => Math.max(a, b[1]), 0);
    if (furthest < 2) continue;

    // **And rich enough to build anything.** Depth alone picked a nation whose
    // mines could not feed six factories: sufficiency sat near zero and the
    // artillery line turned out 0.7 guns in two thousand ticks. That is
    // invariant 2 working exactly as designed and a gate that can never
    // finish its own setup. Steel is what a line draws most of.
    const steel = [...depth.keys()].reduce(
      (sum, id) => sum + (deposits.get(id) ?? 0),
      0,
    );
    if (steel < 4) continue;
    const score = furthest * 100 + steel * 10 + usable.length;
    if (best === null || score > best.score) {
      best = { nation, capitals, depth, usable, furthest, score };
    }
  }
  return best;
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

function lineOf(economy, id) {
  return economy.productionLines.find((line) => line.id === id);
}

/**
 * Whatever an earlier run left behind.
 *
 * Divisions matter: they cost manpower that is never refunded and they count
 * against coverage, so inheriting six of them from the last run silently
 * changes the number this gate is measuring. Lines go too, but they are put
 * straight back — this gate needs factories making things, it just needs to
 * know exactly which lines they are.
 */
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
const SETUP_BUDGET_MS = 240_000;

/** Equipment a division needs before attrition has anything to take from it. */
const MIN_STRENGTH = 0.05;

/**
 * Ticks spent making artillery before the factories retool for rifles.
 *
 * A division wants 12 guns and 100 rifles, and a gun is four industrial points
 * against a rifle's one — so guns are roughly a third of the work and get
 * roughly a third of the time.
 */
const GUN_TICKS = 700;

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
  const mapId = spectator.map.id;
  const neighbours = await neighbourLists(mapId);

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
  const provinces = {
    nations: spectator.nations.length,
    capitals: meta.provinces.filter((p) => p.capital).map((p) => p.id),
    deposits: new Map(
      meta.provinces.map((p) => [p.id, p.resourceDeposits?.steel ?? 0]),
    ),
  };

  // Not simply the biggest nation. Supply is a distance, so the gate needs one
  // with somewhere far to stand — and one whose far provinces it *owns*,
  // because a division cannot be raised on occupied ground.
  const chosen = deepestNation(spectator, neighbours, provinces);
  spectator.close();
  if (chosen === null) {
    log("");
    log("  No nation on this world owns four connected provinces reaching two");
    log("  hops from a capital with steel enough to build with, so there is");
    log("  nowhere to be out of supply that could also arm anything.");
    log("  That is a world this gate cannot use, not a finding. Let it run on");
    log("  (ownership follows control by OCCUPATION_TICKS) and try again.");
    log("");
    process.exit(2);
  }
  const nation = chosen.nation;

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

  const hubs = player.buildings.filter(
    (unused, index) =>
      index % BUILDING_COUNT === SUPPLY_HUB && player.buildings[index] > 0,
  ).length;
  const sources = chosen.capitals.length + hubs;
  check(sources > 0, `the nation draws supply from ${sources} source(s)`);

  // Only ground it owns can take a division, so only that is ranked. The path
  // to it may run over occupied territory; supply does not care who the deeds
  // belong to, only who is standing there.
  const ranked = chosen.usable.sort((a, b) => a[1] - b[1]);
  log(
    `  playing nation ${nation}: ${ranked.length} of its own provinces ` +
      `connected to ${chosen.capitals.length} capital(s), the furthest ` +
      `${chosen.furthest} hops out`,
  );
  const depth = chosen.depth;

  // Exactly what the hubs can carry, so national coverage is 1 and the only
  // thing that can differ between these divisions is how far out they are.
  const wanted = Math.min(4, sources * SUPPLY_SOURCE_THROUGHPUT);
  const near = ranked.slice(0, 1).map(([province]) => province);
  // **On the source itself, not merely near it.** The first version of this
  // counter-proof put everybody one hop out and passed: a hop is 86% supply,
  // 86% is short, and short divisions waste away exactly as the gate says they
  // do. A counter-proof has to remove the subject, not reduce it — so this one
  // stands every division on a province that is zero hops from a source, where
  // supply is 1 and there is nothing for the gate to find.
  const far =
    BREAK === "supplied"
      ? ranked
          .filter(([, hops]) => hops === 0)
          .slice(1, wanted)
          .map(([province]) => province)
      : ranked.slice(-(wanted - 1)).map(([province]) => province);
  if (BREAK === "supplied") {
    log("  --break=supplied: everybody stands on a source");
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

  // A division is raised empty, and attrition cannot take anything from a
  // division that holds nothing — the first version of this gate swept the
  // production lines away for tidiness and then waited two minutes for a
  // strength that was never going to leave zero. So: make some equipment,
  // let them draw it, and only then stop the factories.
  //
  // Both types, because `divisionStrength` is the *worst* ratio across the
  // template (§6.3) and a warehouse of rifles with no guns is a division at
  // zero.
  log("  giving them something to lose...");
  const rifles = await createLine(player, "infantry_equipment", "rifles");
  const guns = await createLine(player, "artillery", "guns");
  const held = player.economy.militaryFactoriesTotal;
  log(`  ${held} military factor${held === 1 ? "y" : "ies"} to work with`);

  // **One type at a time, on every factory the nation has.** Splitting them
  // does not work: a nation with a single military factory gives it to
  // whichever line asks first and the other line gets nothing, so the
  // divisions sit at zero for ever — `divisionStrength` is the worst ratio
  // across the template, and half a template is nothing. Moving factories
  // between lines is free (§6.2 resets only on a type change), so the gate
  // makes guns, then makes rifles, then stops.
  // **Wait on strength, never on the stockpile.** The stockpile is a
  // pass-through while any division is below template: `reinforce` hands out a
  // fraction of every division's shortfall every tick, and four divisions
  // wanting artillery drain it faster than two factories can make it. Waiting
  // for "ten guns in store" therefore waits for ever — measured, with the
  // warehouse reading 0.3 while the line had been running for 270 ticks and
  // the nation sat at sufficiency 1.0 with five thousand steel. The equipment
  // was not missing; it was already in the divisions.
  // The guns phase runs for a fixed stretch of ticks rather than waiting for a
  // signal, because there is no signal to wait for: `divisionStrength` is the
  // **worst** ratio across the template (§6.3), so a division holding guns and
  // no rifles still reads zero, and the stockpile stays near empty because the
  // divisions draw the guns as fast as they are made. Neither number moves
  // until both halves exist. So: make guns for a while, then make rifles, and
  // let the strength check at the end say whether it worked.
  const gunsFrom = player.tick;
  const onGuns = await assignUpTo(player, guns, held, "on-guns");
  // Asserted, not assumed. The first run of this shape spent six minutes
  // equipping nothing because the artillery line silently held no factories,
  // and every check after it was measuring an empty division.
  check(
    onGuns > 0,
    `${onGuns} factor${onGuns === 1 ? "y" : "ies"} on artillery`,
  );
  await player.waitUntil(
    (p) => p.tick >= gunsFrom + GUN_TICKS,
    `${GUN_TICKS} ticks of artillery`,
    SETUP_BUDGET_MS / 3,
  );
  log(`  ${GUN_TICKS} ticks of guns made; retooling for rifles`);

  await player.command(
    { kind: "assign_factories", lineId: guns, factories: 0 },
    "off-guns",
  );
  await player.waitUntil(
    (p) => (lineOf(p.economy, guns)?.factories ?? -1) === 0,
    "the guns line to stand down",
    20_000,
  );
  const onRifles = await assignUpTo(player, rifles, held, "on-rifles");
  check(
    onRifles > 0,
    `${onRifles} factor${onRifles === 1 ? "y" : "ies"} on infantry equipment`,
  );

  const equipped = await player.waitUntil(
    (p) =>
      (p.economy.divisions.find((d) => d.id === worst)?.strength ?? 0) >=
      MIN_STRENGTH,
    `the divisions to reach ${MIN_STRENGTH * 100}% equipment`,
    SETUP_BUDGET_MS / 2,
  );
  check(
    equipped,
    `the divisions drew enough to have something to lose ` +
      `(${((player.economy.divisions.find((d) => d.id === worst)?.strength ?? 0) * 100).toFixed(1)}%)`,
  );

  // And now stop making it, so that the only thing that can move a division's
  // equipment downwards is attrition — and the only thing that could move it
  // upwards is gone.
  for (const line of [rifles, guns]) {
    await player.command(
      { kind: "assign_factories", lineId: line, factories: 0 },
      `off-${line}`,
    );
  }
  await player.waitUntil(
    (p) => p.economy.productionLines.every((line) => line.factories === 0),
    "the factories to stand down",
    30_000,
  );

  log("  watching the line stretch...");

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
  log(`  the front came within reach of one of them on ${disturbed} tick(s)`);

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
