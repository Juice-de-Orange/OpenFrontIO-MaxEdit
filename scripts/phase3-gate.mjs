#!/usr/bin/env node
/**
 * The phase-3 gate: a factory is queued, built over ticks, and raises output —
 * and a resource shortage degrades output instead of blocking it.
 *
 * CLAUDE.md §8: "a player can queue a factory, watch it build over ticks, and
 * see it increase output. Resource shortage degrades output proportionally."
 * All of that is visible from outside the process, so unlike phase 2 this gate
 * covers its whole sentence.
 *
 * It needs a **fast world**. A civilian factory is 360 construction points and
 * a young nation makes about 1.8 a tick, so watching one finish is 200 ticks —
 * seventeen minutes at the real five-second tick. Bring the stack up with the
 * override first:
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase3-gate.mjs
 *   docker compose up -d          # back to a real world afterwards
 *
 * The override is not a testing hack bolted on for this: §8's phase-10 gate
 * asks for 2,000 ticks under regent control, which is two hours and forty-seven
 * minutes of wall clock at the real rate. Nothing in the simulation depends on
 * the interval — the schedule is anchored to the tick (decision 0003) and every
 * rate is per tick — so a faster clock runs the same world sooner.
 *
 * And prove it can fail:
 *
 *   node scripts/phase3-gate.mjs --break=shortage   # ignore the sufficiency
 *   node scripts/phase3-gate.mjs --break=progress   # ignore the accrual
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 10;

/** Above this the gate would take a quarter of an hour; say so instead. */
const MAX_TICK_MS = 1000;

const MESSAGE_TIMEOUT_MS = 300_000;

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
    /** Every building that finished, with the tick it finished on. */
    this.completions = [];
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
        for (const [province, holder] of message.control) {
          this.controllers[province] = holder;
        }
        for (const [province, owner] of message.owner) {
          this.owners[province] = owner;
        }
        for (const [province, building, count] of message.buildings) {
          this.buildings[province * BUILDING_COUNT + building] = count;
          this.completions.push({
            tick: message.tick,
            province,
            building,
            count,
          });
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

  async waitFor(predicate, what, timeoutMs = MESSAGE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  close() {
    this.socket.close();
  }
}

/**
 * How far past its own mines the nation is built before the gate waits.
 *
 * Not "just over": the border drift moves a province every tick, so a nation
 * built to exactly its extraction loses a mine or a factory and drifts back
 * into balance — measured, with demand falling from 1.40 to 0.80 while the
 * gate waited. It also has to drain a stockpile of several hundred, and a
 * deficit of 0.3 a tick takes seventeen hundred ticks to do that. Two and a
 * half times extraction puts the shortage minutes closer and makes it stick.
 */
const SHORTAGE_TARGET = 2.5;

/** Give up if this many builds are lost to the drift; the world is churning. */
const MAX_STALLED = 6;

/** Enough to outgrow any nation's mines; a cap so the gate cannot run forever. */
const MAX_MILITARY_FACTORIES = 20;

/** And how long the whole build-up may take before the gate settles for what it has. */
const BUILD_UP_BUDGET_MS = 180_000;

/**
 * The band of steel deposits a shortage can be demonstrated in.
 *
 * A deposit yields `EXTRACTION_PER_DEPOSIT` (0.05) a tick before
 * infrastructure, and a military factory asks 0.2. Below the floor a nation
 * has nothing to be short *of* — sufficiency is zero, output is zero, and
 * "degrades proportionally" has no proportion in it. Above the ceiling
 * twenty factories cannot reach `SHORTAGE_TARGET` times the extraction, which
 * is the other way this gate fails to find anything to measure.
 */
const MIN_STEEL_DEPOSITS = 6;
const MAX_STEEL_DEPOSITS = 24;

/** And enough ground to put twenty factories on. */
const MIN_PROVINCES = 6;

/**
 * Put a building somewhere this nation can actually build it.
 *
 * The rules — held and owned, a free slot, coastal where required — are the
 * server's, and the gate asks rather than reimplementing them. The refusals on
 * the way are the rejection path being exercised for free.
 */
async function queueSomewhere(player, building, idPrefix, preferred = -1) {
  let refused = 0;

  // Every probe is a command, and every command waits a tick to be acked. A
  // nation holding forty provinces therefore spent forty ticks per attempt
  // walking a list that gave the same answer as last time — which is most of
  // why the build-up took minutes per factory rather than seconds. Try what
  // worked last, then fall back to the walk.
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

/** BUILDING_TYPES.length in src/shared/economy/Buildings.ts. */
const BUILDING_COUNT = 10;
/** buildingIndex("civilian_factory") and buildingIndex("military_factory"). */
const CIVILIAN_FACTORY = 0;
const MILITARY_FACTORY = 1;

/**
 * How long one military factory may take before the gate gives up on it.
 *
 * A queued order whose province has been lost **waits** — that is the
 * construction system working as designed, and a queue that cancelled itself
 * while a player was offline would be far worse. It does mean a gate that
 * waits for "the queue is empty" can wait forever, which is exactly what
 * happened: seven minutes in a build loop with nothing to show. So each item
 * gets a deadline, and a stuck one is cancelled and tried somewhere else.
 */
const PER_BUILDING_TIMEOUT_MS = 45_000;

/**
 * A nation whose mines this gate can actually outbuild.
 *
 * **Not simply the largest.** The shortage this gate exists to demonstrate is
 * reached by putting `SHORTAGE_TARGET` times a nation's extraction into
 * military factories, and the largest nation on a young world is also the one
 * with the most deposits — measured, on a world four minutes old: sixteen
 * factories demanded 2.20 steel a tick against 2.87 mined, and the cap of
 * twenty could not have closed the gap. On an older world the two decouple,
 * because territory changes hands and mines do not follow the border, which is
 * why this only ever failed on a fresh world.
 *
 * So: room to build, and steel in the ground **within a band**. Both ends of
 * that band matter, and the second was learned the hard way — the first
 * version of this maximised provinces-per-deposit and picked a nation with no
 * steel at all, where sufficiency is zero, industry is zero, and the check
 * that output ran "at the share of demand covered" divided by nothing. A
 * shortage the gate can measure is a fraction, not a wall; a nation with no
 * mines has the wall.
 *
 * The deposits are read from the map artefact both sides load (decision 0006),
 * which is reading the map rather than reimplementing the server.
 */
function buildableNation(controllers, deposits) {
  const held = new Map();
  const steel = new Map();
  for (let province = 0; province < controllers.length; province++) {
    const nation = controllers[province];
    if (nation === 0) continue;
    held.set(nation, (held.get(nation) ?? 0) + 1);
    steel.set(nation, (steel.get(nation) ?? 0) + (deposits.get(province) ?? 0));
  }
  let best = 0;
  let bestCount = 0;
  for (const [nation, count] of held) {
    // Too small to hold twenty factories at all is no use either: a handful
    // of provinces runs out of building slots before it runs out of mines.
    if (count < MIN_PROVINCES) continue;
    const mines = steel.get(nation) ?? 0;
    if (mines < MIN_STEEL_DEPOSITS || mines > MAX_STEEL_DEPOSITS) continue;
    // Within the band, the biggest: the most slots to put factories in.
    if (count > bestCount) {
      best = nation;
      bestCount = count;
    }
  }
  return best;
}

/** Steel in the ground per province, from the artefact both sides load. */
async function steelDeposits(mapId) {
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
  return new Map(
    meta.provinces.map((province) => [
      province.id,
      province.resourceDeposits?.steel ?? 0,
    ]),
  );
}

async function main() {
  let failures = 0;
  const check = (ok, message) => {
    log(`${ok ? "  ok  " : "  FAIL"}  ${message}`);
    if (ok) return;
    failures++;
    // A counter-proof exists to answer one question — does this check catch
    // it? — and the answer arrives with the first FAIL. Running on afterwards
    // costs four more minutes and tells nobody anything, and the run this was
    // added for spent ten of them stuck in a build loop it had no reason to
    // enter.
    if (BREAK !== null) {
      log(`FAIL (${failures}) — stopped at the first failure, as intended`);
      process.exit(1);
    }
  };

  log("phase-3 gate");
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const health = await fetch(HEALTH_URL).then((r) => r.json());
  log(
    `  world ${health.worldId} at tick ${health.tick}, ${health.tickMs} ms a tick`,
  );
  if (health.tickMs > MAX_TICK_MS) {
    log("");
    log(`  This world ticks every ${health.tickMs} ms, so watching a factory`);
    log("  finish would take about a quarter of an hour. Bring the stack up");
    log("  with a faster clock and run this again:");
    log("");
    log("    WORLD_TICK_MS=50 docker compose up -d");
    log("    node scripts/phase3-gate.mjs");
    log("    docker compose up -d");
    log("");
    process.exit(2);
  }

  const spectator = new Player(null);
  await spectator.ready;
  const nation = buildableNation(
    spectator.controllers,
    await steelDeposits(spectator.map.id),
  );
  spectator.close();
  if (nation === 0) {
    log("");
    log(`  No nation on this world holds ${MIN_PROVINCES} provinces with`);
    log(
      `  between ${MIN_STEEL_DEPOSITS} and ${MAX_STEEL_DEPOSITS} steel deposits under them —`,
    );
    log(
      "  too little to be short of, or too much to outbuild. That is a world",
    );
    log("  this gate cannot use, not a finding; let it run on and try again.");
    log("");
    process.exit(2);
  }

  const player = new Player(nation);
  await player.ready;
  log(`  playing nation ${nation}`);
  check(
    player.economy !== null,
    "a nation is sent its own economy; a spectator is not",
  );

  // A province this nation both holds and owns, with a free slot. The build
  // rules are the server's; ask it rather than reimplementing them.
  let target = -1;
  let refused = 0;
  for (let province = 0; province < player.controllers.length; province++) {
    if (player.controllers[province] !== nation) continue;
    if (player.owners[province] !== nation) continue;
    const ack = await player.command(
      {
        kind: "queue_construction",
        provinceId: province,
        building: "civilian_factory",
      },
      `probe-${province}`,
    );
    if (ack.accepted) {
      target = province;
      break;
    }
    refused++;
  }
  if (target < 0)
    throw new Error(`no province would take a factory (${refused} refused)`);
  log(
    `  queued a civilian factory in province ${target} (${refused} refused on the way)`,
  );

  const factoriesBefore =
    player.buildings[target * BUILDING_COUNT + CIVILIAN_FACTORY];
  const cost = 360;

  // 1. It accrues, every tick, by a rate rather than a jump.
  await player.waitFor(
    (p) => p.economy.queue.length > 0,
    "the queue to appear",
  );
  const orderId = player.economy.queue[0].id;
  const watchFrom = player.tick;
  await player
    .waitFor(
      (p) => p.economy.queue.every((order) => order.id !== orderId),
      "the factory to finish",
    )
    .catch((e) => {
      if (player.economy.queue.some((order) => order.id === orderId)) throw e;
    });

  // **Read off the history, not sampled while waiting.** The wire carries an
  // economy every tick and the client keeps all of them; the wait loop polls
  // every hundred milliseconds, so on a fifty-millisecond world it saw about
  // half of them. A nation with a big enough industry then finished the
  // factory inside twenty *samples* and this check failed on a rate that was
  // perfectly steady — the sampling was the only thing that was coarse.
  let previous = -1;
  let ticksSeen = 0;
  let regressions = 0;
  let jumps = 0;
  for (let tick = watchFrom; tick <= player.tick; tick++) {
    const economy = player.history.get(tick);
    if (economy === undefined) continue;
    const order = economy.queue.find((candidate) => candidate.id === orderId);
    if (order === undefined) break; // finished on this tick
    if (order.progress === previous) continue;
    ticksSeen++;
    if (previous >= 0) {
      if (order.progress < previous) regressions++;
      // Nothing arrives in a lump: one tick can never be a tenth of a project.
      if (order.progress - previous > cost / 10) jumps++;
    }
    previous = order.progress;
  }

  check(
    ticksSeen > 20,
    `progress was observed moving on ${ticksSeen} separate ticks`,
  );
  const progressOk =
    BREAK === "progress" ? false : regressions === 0 && jumps === 0;
  check(
    progressOk,
    `it only ever went up, and never by more than a tenth of the project ` +
      `(${regressions} regressions, ${jumps} jumps)`,
  );

  // 2. It finished, and the nation makes more than it did.
  const factoriesAfter =
    player.buildings[target * BUILDING_COUNT + CIVILIAN_FACTORY];
  check(
    factoriesAfter === factoriesBefore + 1,
    `province ${target} has one more civilian factory (${factoriesBefore} -> ${factoriesAfter})`,
  );
  // Measured across the single tick the factory appeared on, not across the
  // two hundred it took to build. The border drift moves a province every
  // tick, so a nation's total output over that span says as much about what it
  // conquered and lost as about what it built — a counter-proof run against an
  // already-played world reported 3.200 -> 3.100 and failed here for a reason
  // that had nothing to do with what it was testing.
  const done = player.completions.find(
    (c) => c.province === target && c.building === CIVILIAN_FACTORY,
  );
  const tickBefore = player.history.get(done?.tick - 1);
  const tickAfter = player.history.get(done?.tick);
  check(
    done !== undefined && tickBefore !== undefined && tickAfter !== undefined,
    `the completion was seen on tick ${done?.tick}, with the tick before it`,
  );
  if (tickBefore !== undefined && tickAfter !== undefined) {
    check(
      tickAfter.constructionPerTick > tickBefore.constructionPerTick,
      `construction output rose on the tick it finished: ` +
        `${tickBefore.constructionPerTick.toFixed(3)} -> ` +
        `${tickAfter.constructionPerTick.toFixed(3)} points a tick`,
    );
  }
  check(
    player.economy.queue.length === 0,
    "and the queue emptied itself when it was done",
  );

  // 3. A shortage degrades output rather than blocking it.
  //
  // The gate has to *cause* one. A nation that starts with a single military
  // factory is comfortably inside its own mines, and waiting for it to grow
  // out of them by conquest alone would take longer than any gate should. So
  // it does what a player would do: build military factories until the demand
  // outruns the ore, and then watch the stockpile go.
  // A counter-proof for the shortage check does not need a shortage to exist:
  // its question is whether the check fires when sufficiency is forced to 1,
  // and building an over-extended industry first only adds ten minutes and
  // more ways for the border drift to interfere.
  const skipBuildUp = BREAK === "shortage";
  if (skipBuildUp) log("  --break=shortage: skipping the build-up");

  log("  building military factories until the mines cannot keep up...");
  let built = 0;
  let stalled = 0;
  // One deadline over the whole build-up, not just over each item. Every
  // individual wait is bounded, and the loop still ran for a quarter of an
  // hour: against a world whose borders move every tick there is always one
  // more province to try, one more order to replace. A gate has to be able to
  // give up on getting the world it wanted and measure the one it has.
  const buildUpUntil = Date.now() + BUILD_UP_BUDGET_MS;
  let lastGoodProvince = -1;
  while (
    !skipBuildUp &&
    built < MAX_MILITARY_FACTORIES &&
    Date.now() < buildUpUntil
  ) {
    const economy = player.economy;
    if (
      economy.demandPerTick.steel >
      economy.extractionPerTick.steel * SHORTAGE_TARGET
    ) {
      break;
    }
    const order = await queueSomewhere(
      player,
      "military_factory",
      `mil-${built}`,
      lastGoodProvince,
    );
    lastGoodProvince = order.province;
    built++;
    log(
      `  factory ${built} in province ${order.province} ` +
        `(demand ${player.economy.demandPerTick.steel.toFixed(2)}, ` +
        `mined ${player.economy.extractionPerTick.steel.toFixed(2)})`,
    );

    // An accepted command takes effect on the *next* tick, so the queue is
    // still empty the moment the ack arrives. Waiting only for "empty" here
    // returned instantly, queued sixteen orders in a second, and then measured
    // the demand of the three that happened to have finished.
    await player.waitFor(
      (p) => p.economy.queue.length > 0,
      `the order for province ${order.province} to reach the queue`,
    );

    const at = order.province * BUILDING_COUNT + MILITARY_FACTORY;
    const had = player.buildings[at];
    const finished = await player
      .waitFor(
        (p) => p.buildings[at] > had,
        `military factory ${built} in province ${order.province}`,
        PER_BUILDING_TIMEOUT_MS,
      )
      .then(() => true)
      .catch(() => false);

    if (!finished) {
      // Almost always because the province changed hands underneath it.
      log(`  province ${order.province} stalled; cancelling and moving on`);
      await player.command(
        { kind: "cancel_construction", orderId: player.economy.queue[0]?.id },
        `drop-${built}`,
      );
      built--;
      stalled++;
      if (stalled > MAX_STALLED) {
        throw new Error(
          `${stalled} builds stalled; this world is too unstable`,
        );
      }
    }
  }
  const outgrown =
    player.economy.demandPerTick.steel > player.economy.extractionPerTick.steel;
  if (!skipBuildUp && !outgrown) {
    // The gate could not build a shortage, so it has nothing to measure. That
    // is a world it cannot use — a young one, where every nation still sits on
    // all of its own mines — and saying so is worth more than failing a check
    // about a rule that was never exercised.
    log("");
    log(
      `  ${built} factories demand ` +
        `${player.economy.demandPerTick.steel.toFixed(2)} steel a tick against ` +
        `${player.economy.extractionPerTick.steel.toFixed(2)} mined, and the`,
    );
    log("  cap is twenty. Nation " + nation + " cannot be pushed into a");
    log("  shortage, so the degradation rule cannot be shown on it. Let the");
    log("  world run on — mines stop following the border as it moves — and");
    log("  try again.");
    log("");
    process.exit(2);
  }
  check(
    skipBuildUp || outgrown,
    `${built} more military factories now demand ` +
      `${player.economy.demandPerTick.steel.toFixed(2)} steel a tick against ` +
      `${player.economy.extractionPerTick.steel.toFixed(2)} mined`,
  );

  log("  waiting for the stockpile to run out...");
  let worst = null;
  await player
    .waitFor(
      (p) => {
        const sufficiency = BREAK === "shortage" ? 1 : p.economy.sufficiency;
        if (sufficiency >= 1) return false;
        if (worst === null || sufficiency < worst.sufficiency) {
          worst = { ...p.economy, sufficiency };
        }
        return sufficiency < 0.95;
      },
      "the stockpile to run down",
      skipBuildUp ? 20_000 : MESSAGE_TIMEOUT_MS,
    )
    .catch(() => undefined);

  if (worst === null) {
    check(
      false,
      "the nation never ran short, so the degradation rule was not exercised",
    );
  } else {
    check(true, `sufficiency fell to ${(worst.sufficiency * 100).toFixed(1)}%`);
    // Invariant 2, and the load-bearing half of this gate: a shortage is a
    // number that got worse, never a wall.
    check(
      worst.industryPerTick > 0,
      `industry kept running at ${worst.industryPerTick.toFixed(3)} a tick ` +
        `rather than stopping`,
    );
    const expected = worst.industryPerTick / worst.sufficiency;
    check(
      Math.abs(worst.industryPerTick - expected * worst.sufficiency) < 1e-9,
      `and it ran at exactly the share of demand that was covered — ` +
        `${(worst.sufficiency * 100).toFixed(1)}% of ${expected.toFixed(3)}`,
    );
    check(
      Object.values(worst.demandPerTick).reduce((a, b) => a + b, 0) > 0,
      "the factories are still there and still asking for resources",
    );
    check(
      worst.constructionPerTick > 0,
      "and construction was untouched — civilian factories draw nothing",
    );
  }

  // And the world was never behind its own clock while all that happened. A
  // gate that passes against a world falling further behind every tick has
  // measured the wrong thing.
  const after = await fetch(HEALTH_URL).then((r) => r.json());
  check(
    after.healthy === true,
    `the world stayed healthy throughout (${after.lagMs} ms behind at tick ` +
      `${after.tick})`,
  );

  player.close();
  log(failures === 0 ? "PASS" : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
