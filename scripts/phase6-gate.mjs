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
 * So it raises at most `sources x SUPPLY_SOURCE_THROUGHPUT` divisions, which
 * puts national coverage at exactly 1 and leaves **distance** as the only
 * thing that can differ between them. Both the ones it watches stand in
 * provinces every neighbour of which is the nation's own, and so is every
 * neighbour of those: the front cannot reach a division standing there, which
 * is how "without enemy action" is made true rather than hoped for. The window
 * lasts as long as that shelter does.
 *
 * The far one is not the furthest. A division at zero supply never holds
 * anything to lose, so the gate stands one at every distance it can reach and
 * watches whichever landed between `BAND_LOW` and `BAND_HIGH`.
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
const PROTOCOL_VERSION = 19;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

const MESSAGE_TIMEOUT_MS = 300_000;

/** BUILDING_TYPES.length, and buildingIndex of the two this gate reads. */
const BUILDING_COUNT = 10;
const MILITARY_FACTORY = 1;
const SUPPLY_HUB = 7;

/**
 * Military factories the chosen nation needs.
 *
 * Two, because the setup runs a rifle line and an artillery line **at the same
 * time** — one type at a time cannot arm a division that is losing equipment,
 * which is the measurement this gate rests on. A nation with one factory gives
 * one of the two lines nothing and the division never leaves zero. Every nation
 * starts with exactly one (`STARTING_CAPITAL_BUILDINGS`), so on a young world
 * this is the binding constraint and it used to be discovered six minutes in.
 */
const MIN_MILITARY_FACTORIES = 2;

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
 * A province the front cannot reach, and one whose neighbours it cannot reach
 * either.
 *
 * `combat.ts` only ever flips a province that has a neighbour under someone
 * else's control, and the equipment a flip destroys belongs to the divisions
 * in the province that changed hands and in the one it was attacked from. A
 * province whose every neighbour is ours can be neither. So a division
 * standing in one cannot lose a rifle to the front, and §8's **without enemy
 * action** becomes a property of where this gate stands rather than a hope
 * about what the world does while it watches.
 *
 * `sheltered` asks the same of the neighbours, and that is what makes the
 * shelter last: the ring around a merely interior province can still flip, and
 * the tick it does, the province becomes a border. Measured on world-0 before
 * this was written — twelve sheltered candidates watched for 3,001 ticks, not
 * one lost its shelter and not one was touched.
 */
function interior(player, neighbours, province, nation) {
  return (neighbours.get(province) ?? []).every(
    (next) => player.controllers[next] === nation,
  );
}

function sheltered(player, neighbours, province, nation) {
  if (!interior(player, neighbours, province, nation)) return false;
  return (neighbours.get(province) ?? []).every((next) =>
    interior(player, neighbours, next, nation),
  );
}

/**
 * One province per distance, deepest first.
 *
 * Supply falls with weighted distance and the gate cannot compute it — the
 * wire carries a supply figure per division, not per province (§7) — so it
 * stands somebody at every distance it can reach and reads off which of them
 * landed in the band it can measure. Deepest first, because the far end of the
 * line is what this phase is about.
 */
function spread(entries, count) {
  const byDepth = new Map();
  for (const [province, hops] of entries) {
    if (!byDepth.has(hops)) byDepth.set(hops, province);
  }
  return [...byDepth.keys()]
    .sort((a, b) => b - a)
    .slice(0, count)
    .map((hops) => byDepth.get(hops));
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

    // **And enough industry to run two lines at once.** Checked here rather
    // than discovered in the setup, where it cost six minutes and read as a
    // failure of the simulation.
    const factories = [...depth.keys()].reduce(
      (sum, id) =>
        sum + (player.buildings[id * BUILDING_COUNT + MILITARY_FACTORY] ?? 0),
      0,
    );
    // One is enough to be chosen: the setup builds the second itself, the way
    // a player would. Zero would mean no industry at all, which is a nation
    // this gate cannot arm anything with.
    if (factories < 1) continue;

    // **And somewhere sheltered to stand, at both ends.** A nation with a deep
    // interior and a capital on the front line is no use here: the home
    // division would be measured while a war went past it, and the gate would
    // report the front rather than the supply.
    const home = capitals.filter((id) =>
      sheltered(player, neighbours, id, nation),
    );
    const out = usable.filter(
      ([id, hops]) => hops >= 2 && sheltered(player, neighbours, id, nation),
    );
    if (home.length === 0 || out.length === 0) continue;

    const score = furthest * 100 + steel * 10 + usable.length;
    if (best === null || score > best.score) {
      best = { nation, capitals, depth, usable, furthest, home, out, score };
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

/**
 * Equipment a division needs before attrition has anything to take from it.
 *
 * Not a token amount: the fall has to be unambiguous against a strength that
 * was really there. With both lines running a division at half supply settles
 * near 40% of template, so this is reached well inside the setup budget.
 */
const MIN_STRENGTH = 0.2;

/**
 * The supply band a division can be watched in.
 *
 * Below `BAND_LOW` it never accumulates anything: the draw is a share of the
 * template and the loss is a share of the holding, and at zero supply the
 * second wins from the first tick, so there is no fall to watch. Above
 * `BAND_HIGH` the loss is a fraction of a fraction and the division outlives
 * the window. Measured on world-0: three hops out reads 59%, four reads 48%,
 * seven reads 0%.
 */
const BAND_LOW = 0.15;
const BAND_HIGH = 0.7;

/**
 * How long the shelter has to hold for the window to mean anything.
 *
 * A division at half supply loses about a percent of what it holds per tick,
 * so two hundred ticks is a fall to an eighth — unmistakable. A window that
 * ends sooner has not disproved anything; it has only been interrupted, and
 * saying so is worth more than passing on eight ticks of evidence.
 */
const MIN_WATCH_TICKS = 200;

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
    log(
      `  hops from a capital, with ${MIN_MILITARY_FACTORIES} military factories and steel`,
    );
    log("  enough to build with, and a capital");
    log("  and a far province both far enough behind their own front that the");
    log("  drift cannot reach them, so there is nowhere to be out of supply");
    log("  that could also arm anything and be left alone while it happens.");
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

  // **The nation's own hubs, not the world's.** `buildings` on the wire is
  // every province on the map (§7), so counting every supply hub in it counted
  // fifty-one other nations' as well. `sources` is what the division count is
  // capped by, and too high a cap puts coverage below 1 — which would leave
  // the home division short of the 100% the last check asks it for, for a
  // reason that has nothing to do with distance.
  const hubs = [];
  for (let province = 0; province < player.controllers.length; province++) {
    if (player.controllers[province] !== nation) continue;
    if (player.owners[province] !== nation) continue;
    if (player.buildings[province * BUILDING_COUNT + SUPPLY_HUB] > 0) {
      hubs.push(province);
    }
  }
  const sources = chosen.capitals.length + hubs.length;
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

  // Exactly what the sources can carry, so national coverage is 1 and the only
  // thing that can differ between these divisions is how far out they are.
  const wanted = Math.min(4, sources * SUPPLY_SOURCE_THROUGHPUT);

  // **Home is a source, not a province near one.** Supply is reach times
  // coverage, reach is 1 only at distance 0, and the last check asks the home
  // division for everything it wants.
  const near = [chosen.home[0]];

  // **And away is not simply the furthest province.** A division at zero
  // supply never holds anything to lose: it draws a fixed share of its
  // template out of the stockpile and attrition takes a share of what it holds
  // straight back, so at zero it settles at nothing and there is no fall to
  // watch. Measured on world-0 — seven hops out reads 0% supply, and the
  // division this gate was watching sat at 0.0% strength for the whole window
  // while every check downstream of it failed.
  //
  // What the gate wants is the middle of the line: short enough to bite,
  // long enough to have been given something first. It cannot compute where
  // that is, because supply reaches the wire per division and not per
  // province — so it stands a division at every distance it can reach and
  // then reads off which of them landed in the band.
  //
  // **On the source itself, not merely near it,** for the counter-proof. Its
  // first version put everybody one hop out and passed: a hop is 86% supply,
  // 86% is short, and short divisions waste away exactly as the gate says they
  // do. A counter-proof has to remove the subject, not reduce it.
  const far =
    BREAK === "supplied"
      ? chosen.capitals.filter((id) => id !== near[0]).slice(0, wanted - 1)
      : spread(chosen.out, wanted - 1);
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

  const supplyRead = (id) => supplyNow.get(id) ?? 0;
  const best = raised.reduce((a, b) =>
    supplyRead(a) >= supplyRead(b) ? a : b,
  );

  // The division to watch is the one inside the band, not the worst-off one.
  // Below the band it holds nothing and there is nothing to take from it;
  // above it the fall is too slow to see inside this window. Lowest in the
  // band, because that is the one that falls fastest and stands furthest from
  // the one at home.
  const band = raised
    .filter((id) => supplyRead(id) > BAND_LOW && supplyRead(id) < BAND_HIGH)
    .sort((a, b) => supplyRead(a) - supplyRead(b));
  if (band.length === 0 && BREAK === null) {
    log("");
    log("  None of these divisions is standing where this gate can measure:");
    log(
      `  supply strictly between ${BAND_LOW * 100}% and ${BAND_HIGH * 100}%.`,
    );
    log("  Below that a division never accumulates anything to lose, above it");
    log("  it wastes away slower than this window is long. That is a world");
    log("  this gate cannot use, not a finding: let it run on and try again.");
    log("");
    player.close();
    process.exit(2);
  }
  // With a --break= the band may be empty on purpose — that is what
  // `--break=supplied` does — so fall through to the check it is aimed at
  // rather than exiting before it runs.
  const worst =
    band.length > 0
      ? band[0]
      : raised.reduce((a, b) => (supplyRead(a) <= supplyRead(b) ? a : b));
  check(
    (supplyNow.get(best) ?? 0) - (supplyNow.get(worst) ?? 0) > 0.05,
    `the division at the end of the line is worse supplied than the one at ` +
      `home: ${((supplyNow.get(worst) ?? 0) * 100).toFixed(0)}% against ` +
      `${((supplyNow.get(best) ?? 0) * 100).toFixed(0)}%`,
  );

  // Everything from here on is about two divisions, so the rest go. They were
  // raised to find out where the band was, they have done that, and every one
  // left standing is another mouth drawing on a stockpile that is already a
  // pass-through.
  for (const id of raised) {
    if (id === best || id === worst) continue;
    await player.command(
      { kind: "disband_division", divisionId: id },
      `stand-down-${id}`,
    );
  }
  await player.waitUntil(
    (p) => p.economy.divisions.length === 2,
    "the divisions that were only there to measure to stand down",
    30_000,
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

  // **Build what the measurement needs.** Two lines have to run at once — one
  // type at a time cannot arm a division that is losing equipment — and every
  // nation starts with exactly one military factory. Nothing hands out a
  // second any more: since the border drift was replaced by §6.9 (decision
  // 0014) an unattended world does not develop, so a gate that waited for a
  // nation to have grown one would wait for ever. So it builds one, which is
  // what a player would do, and which the phase-3 gate already proves works.
  if (player.economy.militaryFactoriesTotal < MIN_MILITARY_FACTORIES) {
    // Several sites, not one: a capital is where the starting buildings are and
    // is usually out of slots, and the rules for where a factory may go are the
    // server's — the gate asks rather than reimplementing them.
    const sites = [...chosen.usable]
      .sort((a, b) => a[1] - b[1])
      .map(([province]) => province)
      .filter((province) => player.owners[province] === nation);
    let site = null;
    let ack = { accepted: false, reason: "nowhere to build" };
    for (const candidate of sites.slice(0, 12)) {
      ack = await player.command(
        {
          kind: "queue_construction",
          provinceId: candidate,
          building: "military_factory",
        },
        `build-factory-${candidate}`,
      );
      if (ack.accepted) {
        site = candidate;
        break;
      }
    }
    if (!ack.accepted) {
      log(`  could not queue a second factory: ${ack.reason}`);
    } else {
      log(`  building a second military factory in province ${site}...`);
      const built = await player.waitUntil(
        (p) => p.economy.militaryFactoriesTotal >= MIN_MILITARY_FACTORIES,
        "the second military factory",
        SETUP_BUDGET_MS,
      );
      if (!built) {
        log("");
        log(
          "  The factory did not finish inside the setup budget, so there is",
        );
        log("  no way to run two production lines at once and no way to arm a");
        log("  division. That is a world this gate cannot use, not a finding.");
        log("");
        player.close();
        process.exit(2);
      }
    }
  }

  const rifles = await createLine(player, "infantry_equipment", "rifles");
  const guns = await createLine(player, "artillery", "guns");
  const held = player.economy.militaryFactoriesTotal;
  log(`  ${held} military factor${held === 1 ? "y" : "ies"} to work with`);

  // **Both types at once, never one after the other.** This gate ran the
  // other way first — all the factories on guns for seven hundred ticks, then
  // all of them on rifles — and the division it was watching finished at 0.0%
  // both times. Measured, with the lid off: a division short of supply loses a
  // share of what it holds every tick, so whichever type is not being made
  // right now is decaying with a half-life of about seventy ticks at 48%
  // supply. By the time the rifles arrived the guns were gone, and
  // `divisionStrength` is the **worst** ratio across the template (§6.3), so
  // a division holding a hundred rifles and no guns reads zero. One type at a
  // time cannot arm a division that is losing equipment; it can only take
  // turns starving it.
  //
  // Run in parallel they settle instead: production per tick against a loss
  // proportional to the holding is a first-order lag, and the division sits at
  // whatever the line can sustain. Guns get a third of the factories because a
  // gun costs four industrial points against a rifle's one and the template
  // wants twelve against a hundred — about two to one in work.
  //
  // **And wait on strength, never on the stockpile.** The stockpile is a
  // pass-through while any division is below template: `reinforce` hands out a
  // share of the template every tick, and the divisions draw it as fast as the
  // factories make it. Waiting for "ten guns in store" waits for ever —
  // measured, with the warehouse reading 0.3 while the line had been running
  // for 270 ticks and the nation sat at sufficiency 1.0 with five thousand
  // steel. The equipment was not missing; it was already in the divisions.
  const forGuns = Math.max(1, Math.round(held / 3));
  // Asserted, not assumed. An earlier run spent six minutes equipping nothing
  // because a line silently held no factories, and every check after it was
  // measuring an empty division.
  const onGuns = await assignUpTo(player, guns, forGuns, "on-guns");
  const onRifles = await assignUpTo(player, rifles, held - onGuns, "on-rifles");
  check(
    onGuns > 0 && onRifles > 0,
    `${onRifles} factor${onRifles === 1 ? "y" : "ies"} on rifles and ` +
      `${onGuns} on artillery, both running`,
  );

  const equipped = await player.waitUntil(
    (p) =>
      (p.economy.divisions.find((d) => d.id === worst)?.strength ?? 0) >=
      MIN_STRENGTH,
    `the divisions to reach ${MIN_STRENGTH * 100}% equipment`,
    SETUP_BUDGET_MS,
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
  const watchFrom = player.tick;
  const startStrength = new Map(
    player.economy.divisions.map((d) => [d.id, d.strength]),
  );
  let disturbed = 0;
  let worstMax = startStrength.get(worst) ?? 0;
  let exposed = null;
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

    // Both divisions stand behind a province the front cannot reach, and the
    // window lasts exactly as long as that is still true. Losing the shelter
    // costs nothing on the tick it happens — a flip destroys equipment in the
    // province that changed hands and in the one it was attacked from, and
    // neither can be a province all of whose neighbours are ours — but from
    // the next tick on the division is reachable, and a measurement taken
    // after that would be measuring the war.
    for (const id of [best, worst]) {
      const at = where.get(id);
      if (at === undefined) continue;
      if (!sheltered(player, neighbours, at, nation)) {
        exposed = { id, province: at, tick: player.tick };
        break;
      }
    }
    if (exposed !== null) break;
  }
  const watched = player.tick - watchFrom;
  if (exposed !== null) {
    log(
      `  province ${exposed.province} became reachable at tick ` +
        `${exposed.tick}; the window ends there, ${watched} tick(s) long`,
    );
  } else {
    log(`  watched ${watched} tick(s) with the shelter holding`);
  }
  if (watched < MIN_WATCH_TICKS && BREAK === null) {
    log("");
    log(`  ${watched} ticks is not long enough to say anything. The front`);
    log("  reached one of these provinces while the gate was still watching,");
    log("  so the window was cut short — that is the world moving, not a");
    log("  finding. Run it again; the drift will have gone elsewhere.");
    log("");
    player.close();
    process.exit(2);
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
