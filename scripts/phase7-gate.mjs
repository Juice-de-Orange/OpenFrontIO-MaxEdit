#!/usr/bin/env node
/**
 * The phase-7 gate: an agreement that nobody has to renew.
 *
 * CLAUDE.md §8, phase 7 — "two nations hold a trade agreement across a season
 * restart, with no renewal action from either player. Breaking it costs the
 * visible trust the spec says it should, and the other side is notified before
 * the flow stops."
 *
 * Three claims, and each is checked where it could actually be broken:
 *
 * - **Indefinite** (invariant 3). The agreement is made, the world is killed
 *   and comes back from its snapshot and command log, and the agreement is
 *   still there with the same id and the same terms — without either side
 *   having sent anything in between. There is no renewal command in the
 *   protocol to send.
 * - **The exit is what costs.** Notice is given and the canceller's trust
 *   falls by exactly `TRUST_COST.trade`, on a number every other nation can
 *   see.
 * - **Notified before it stops.** The other side can see the notice on the
 *   tick it is given, while the flow is still running — that in-game day is
 *   the whole point of the notice period, and it is the only duration in §6.5.
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase7-gate.mjs
 *   docker compose up -d
 *
 * And prove it can fail:
 *
 *   node scripts/phase7-gate.mjs --break=survives   # cancelled before the restart
 *   node scripts/phase7-gate.mjs --break=notified   # look only after it stopped
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const run = promisify(execFile);

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 19;

/** Above this the notice period alone would take four minutes. */
const MAX_TICK_MS = 200;

/** What this world is actually ticking at, read from /health on the way in. */
let TICK_MS = 50;

/** AGREEMENT_NOTICE_TICKS and TRUST_COST.trade in shared/config/diplomacy.ts. */
const NOTICE_TICKS = 24;
const TRUST_COST_TRADE = 5;

/** RESOURCE_CAP in shared/config/rates.ts: the ceiling on one resource. */
const RESOURCE_CAP = 5000;

/** The terms this gate offers. Small enough for a nation on its first day. */
const RESOURCE = "material";
const RESOURCE_PER_TICK = 0.5;
const POINTS_PER_TICK = 0.25;

const MESSAGE_TIMEOUT_MS = 120_000;

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
    this.trust = [];
    this.agreements = [];
    this.controllers = null;
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
    this.socket.on("error", () => {
      // A restart drops the socket. That is the point of the restart, and the
      // gate reconnects rather than dying on it.
      this.dead = true;
    });
    this.socket.on("close", () => {
      this.dead = true;
    });
  }

  onMessage(message) {
    switch (message.t) {
      case "full":
        this.nations = message.nations;
        this.controllers = message.controllers;
        this.owners = message.owners;
        this.tick = message.tick;
        this.economy = message.economy;
        this.trust = message.trust;
        this.agreements = message.agreements;
        this.onReady();
        break;
      case "delta":
        for (const [province, holder] of message.control) {
          this.controllers[province] = holder;
        }
        this.tick = message.tick;
        this.economy = message.economy;
        this.trust = message.trust;
        this.agreements = message.agreements;
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

  async waitFor(predicate, what, timeoutMs = MESSAGE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(25);
    }
  }

  agreement(id) {
    return this.agreements.find((a) => a.id === id);
  }

  close() {
    this.socket.close();
  }
}

/**
 * `docker compose`, with this world's clock carried through.
 *
 * **The override does not survive a `compose up` on its own.** The compose
 * file reads `WORLD_TICK_MS` from the environment, so a restart started from a
 * shell that does not have it brings the world back at five seconds a tick —
 * and the notice period this gate is waiting on quietly becomes two minutes
 * long. Measured, the first time this gate ran: every check passed and then it
 * timed out waiting for an in-game day that was now twenty-four real ones.
 */
async function compose(...args) {
  const { stdout, stderr } = await run("docker", ["compose", ...args], {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, WORLD_TICK_MS: String(TICK_MS) },
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

/** Nations by how much of the map they hold, largest first. */
function byHoldings(controllers, count) {
  const held = new Array(count + 1).fill(0);
  for (const holder of controllers) {
    if (holder > 0 && holder <= count) held[holder]++;
  }
  return held
    .map((provinces, nation) => ({ nation, provinces }))
    .filter((entry) => entry.nation > 0)
    .sort((a, b) => b.provinces - a.provinces);
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

  log("phase-7 gate");
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const health = await fetch(HEALTH_URL).then((r) => r.json());
  TICK_MS = health.tickMs;
  log(
    `  world ${health.worldId} at tick ${health.tick}, ${health.tickMs} ms a tick`,
  );
  if (health.tickMs > MAX_TICK_MS) {
    log("");
    log(`  This world ticks every ${health.tickMs} ms. The notice period`);
    log(`  alone is ${NOTICE_TICKS} ticks. Bring the stack up faster:`);
    log("");
    log("    WORLD_TICK_MS=50 docker compose up -d --build");
    log("    node scripts/phase7-gate.mjs");
    log("");
    process.exit(2);
  }

  // A spectator picks the pair, and stays to check what a third party is
  // allowed to see.
  const spectator = new Player(null);
  await spectator.ready;
  check(
    spectator.economy === null && Array.isArray(spectator.trust),
    "a spectator is sent trust, which is public, and no economy, which is not",
  );

  const ranked = byHoldings(spectator.controllers, spectator.nations.length);

  // **Everybody who might sign anything is connected first.** §6.5's
  // dead-partner rule holds that an agreement with a nation nobody is playing
  // dissolves by itself, and a nation nobody has *ever* played has been silent
  // since tick zero — so an offer to one is refused rather than swept up a
  // tick later. Connecting is what tells the world a nation is being played,
  // and it is written to the command log like anything else (§4).
  const contenders = ranked.slice(0, 6);
  const players = new Map();
  for (const entry of contenders) {
    const player = new Player(entry.nation);
    await player.ready;
    players.set(entry.nation, player);
  }
  // The presence commands are queued for the next tick; give them one.
  // Captured, not read live: the spectator's own tick is moving too, and
  // comparing two moving numbers waits for ever.
  const connectedAt = spectator.tick;
  await players
    .get(contenders[0].nation)
    .waitFor(
      (p) => p.tick > connectedAt + 2,
      "the world to record that these nations are being played",
      30_000,
    );

  let seller = null;
  let buyer = null;
  let offerId = null;
  let sellerPlayer = null;
  let buyerPlayer = null;

  // The server refuses a trade with no land route between the two — phase 7 is
  // land only, because a sea route has to consume convoys and there are none
  // until phase 9. So the pair is chosen by asking, not by guessing.
  const refusals = new Set();
  for (const candidate of contenders) {
    for (const other of contenders) {
      if (candidate.nation === other.nation) continue;
      if (
        spectator.agreements.some(
          (a) =>
            a.parties.includes(candidate.nation) &&
            a.parties.includes(other.nation),
        )
      ) {
        continue;
      }
      const player = players.get(candidate.nation);
      const partner = players.get(other.nation);
      // **Both sides have to be able to keep the bargain**, or the flow
      // scales to nothing and this gate would be watching invariant 2 work
      // instead of the agreement it came to look at. The seller needs the
      // resource in hand and the buyer needs the construction points to pay
      // with — a nation whose provinces are mostly occupied has neither.
      if ((player.economy?.resources[RESOURCE] ?? 0) < 10 * RESOURCE_PER_TICK) {
        refusals.add(`nation ${candidate.nation} has too little ${RESOURCE}`);
        continue;
      }
      if ((partner.economy?.constructionPerTick ?? 0) < POINTS_PER_TICK * 1.5) {
        refusals.add(
          `nation ${other.nation} does not make enough construction to pay`,
        );
        continue;
      }
      // **And somewhere to put it.** A stockpile has a ceiling, and a flow
      // into a full warehouse is scaled to nothing rather than paid for and
      // discarded. A nation that has been mining a resource it does not use
      // for a few hours sits at exactly that ceiling, so this is the ordinary
      // case on an older world, not an edge.
      if (
        (partner.economy?.resources[RESOURCE] ?? 0) >
        RESOURCE_CAP - 20 * RESOURCE_PER_TICK
      ) {
        refusals.add(`nation ${other.nation} has no room for more ${RESOURCE}`);
        continue;
      }
      const ack = await player.command(
        {
          kind: "propose_agreement",
          to: other.nation,
          type: "trade",
          terms: {
            resource: RESOURCE,
            resourcePerTick: RESOURCE_PER_TICK,
            pointsPerTick: POINTS_PER_TICK,
          },
        },
        `offer-${candidate.nation}-${other.nation}`,
      );
      if (!ack.accepted) {
        refusals.add(ack.reason);
        continue;
      }
      seller = candidate.nation;
      buyer = other.nation;
      sellerPlayer = player;
      buyerPlayer = players.get(other.nation);
      break;
    }
    if (seller !== null) break;
  }

  for (const [nation, player] of players) {
    if (nation !== seller && nation !== buyer) player.close();
  }

  if (seller === null) {
    log("");
    log("  No two of the largest nations on this world can reach each other");
    log("  over land without an agreement already between them:");
    for (const reason of refusals) log(`    ${reason}`);
    log("  That is a world this gate cannot use, not a finding. Try again on");
    log("  a fresh one, or let this one run on.");
    log("");
    process.exit(2);
  }

  log(`  nation ${seller} offers nation ${buyer} a standing trade`);
  await sellerPlayer.waitFor(
    (p) => p.agreements.some((a) => a.parties[0] === seller && !a.accepted),
    "the offer to appear",
    30_000,
  );
  offerId = sellerPlayer.agreements.find(
    (a) => a.parties[0] === seller && a.parties[1] === buyer && !a.accepted,
  ).id;

  await buyerPlayer.waitFor(
    (p) => p.agreement(offerId) !== undefined,
    "the offer to reach the other side",
    30_000,
  );

  const offered = buyerPlayer.agreement(offerId);
  check(
    offered.terms?.resource === RESOURCE &&
      Math.abs(offered.terms.resourcePerTick - RESOURCE_PER_TICK) < 1e-9 &&
      Math.abs(offered.terms.pointsPerTick - POINTS_PER_TICK) < 1e-9,
    "both sides see the exact rates before accepting",
  );

  // §7: trust is public, terms are not. The spectator is the check on that.
  await spectator.waitFor(
    (p) => p.agreement(offerId) !== undefined,
    "the world to see that an offer exists",
    30_000,
  );
  check(
    spectator.agreement(offerId)?.terms === null,
    "a third party sees that the two are talking, and not what about",
  );

  const ack = await buyerPlayer.command(
    { kind: "accept_agreement", agreementId: offerId },
    "accept",
  );
  check(ack.accepted, `the offer was accepted (${ack.reason ?? "accepted"})`);
  await buyerPlayer.waitFor(
    (p) => p.agreement(offerId)?.accepted === true,
    "the agreement to stand",
    30_000,
  );

  // The flow itself, on the wire, from both ends.
  const moving = await buyerPlayer
    .waitFor(
      (p) => (p.economy?.tradePointsOut ?? 0) > 0,
      "the trade to start moving",
      30_000,
    )
    .then(() => true)
    .catch(() => false);
  if (!moving) {
    log("");
    log(`  Nation ${seller} and nation ${buyer} signed, and then nothing`);
    log("  moved: one of them cannot cover its side this tick. That is");
    log("  invariant 2 working, and a world this gate cannot measure the");
    log("  agreement in. Try again on a fresh one.");
    log("");
    process.exit(2);
  }
  const buying = buyerPlayer.economy;
  const selling = sellerPlayer.economy;
  check(
    Math.abs(buying.tradeResourcePerTick[RESOURCE] - RESOURCE_PER_TICK) < 1e-6,
    `the buyer receives ${RESOURCE} at the agreed rate ` +
      `(${buying.tradeResourcePerTick[RESOURCE].toFixed(3)}/tick)`,
  );
  check(
    Math.abs(buying.tradePointsOut - POINTS_PER_TICK) < 1e-6,
    `and pays for it in construction points, which is the only currency ` +
      `there is (${buying.tradePointsOut.toFixed(3)}/tick)`,
  );
  check(
    Math.abs(selling.tradeResourcePerTick[RESOURCE] + RESOURCE_PER_TICK) < 1e-6,
    `the seller is short exactly what it sent ` +
      `(${selling.tradeResourcePerTick[RESOURCE].toFixed(3)}/tick)`,
  );

  // §10 / decision 0027: a second lane between the same two, carrying
  // equipment. The seller needs something in the warehouse to send, so a
  // rifles line runs first and the gate waits for a modest stock. The
  // measurement is the crates moving on the wire: the buyer's stockpile
  // rises and the seller's falls, at the agreed rate, paid in points.
  {
    const RIFLES = 0; // EQUIPMENT_TYPES index of infantry_equipment
    const CRATES_PER_TICK = 0.5;
    const before = new Set(
      sellerPlayer.economy.productionLines.map((l) => l.id),
    );
    const opened = await sellerPlayer.command(
      { kind: "create_production_line", equipment: "infantry_equipment" },
      "rifles-line",
    );
    let stocked = false;
    if (opened.accepted) {
      await sellerPlayer.waitFor(
        (p) => p.economy.productionLines.some((l) => !before.has(l.id)),
        "the rifles line to appear",
        30_000,
      );
      const line = sellerPlayer.economy.productionLines.find(
        (l) => !before.has(l.id),
      );
      const idle =
        sellerPlayer.economy.militaryFactoriesTotal -
        sellerPlayer.economy.militaryFactoriesAssigned;
      if (idle > 0) {
        await sellerPlayer.command(
          { kind: "assign_factories", lineId: line.id, factories: idle },
          "rifles-staff",
        );
      }
      stocked = await sellerPlayer
        .waitFor(
          (p) => (p.economy.stockpile[RIFLES] ?? 0) >= 20 * CRATES_PER_TICK,
          "a few rifles in store",
          180_000,
        )
        .then(() => true)
        .catch(() => false);
    }
    if (!stocked) {
      log(
        "  note  the seller could not stock rifles in time; the equipment lane is not measured on this world",
      );
    } else {
      const lane = await sellerPlayer.command(
        {
          kind: "propose_agreement",
          to: buyer,
          type: "trade",
          terms: {
            resource: RESOURCE,
            resourcePerTick: 0,
            pointsPerTick: POINTS_PER_TICK,
            equipment: { type: "infantry_equipment", perTick: CRATES_PER_TICK },
          },
        },
        "offer-rifles",
      );
      check(
        lane.accepted,
        `a second lane carrying rifles beside the steel is offerable (${lane.reason ?? "accepted"})`,
      );
      if (lane.accepted) {
        await sellerPlayer.waitFor(
          (p) =>
            p.agreements.some(
              (a) =>
                a.parties[0] === seller &&
                a.parties[1] === buyer &&
                !a.accepted &&
                a.terms?.equipment,
            ),
          "the rifles offer to appear",
          30_000,
        );
        const riflesId = sellerPlayer.agreements.find(
          (a) =>
            a.parties[0] === seller &&
            a.parties[1] === buyer &&
            !a.accepted &&
            a.terms?.equipment,
        ).id;
        await buyerPlayer.waitFor(
          (p) => p.agreement(riflesId) !== undefined,
          "the rifles offer to arrive",
          30_000,
        );
        check(
          buyerPlayer.agreement(riflesId)?.terms?.equipment?.type ===
            "infantry_equipment",
          "the buyer sees the equipment named in the terms",
        );
        const held = buyerPlayer.economy.stockpile[RIFLES] ?? 0;
        const sellerHeld = sellerPlayer.economy.stockpile[RIFLES] ?? 0;
        const took = await buyerPlayer.command(
          { kind: "accept_agreement", agreementId: riflesId },
          "accept-rifles",
        );
        check(
          took.accepted,
          `the rifles lane was accepted (${took.reason ?? "accepted"})`,
        );
        const arrived = await buyerPlayer
          .waitFor(
            (p) =>
              (p.economy.stockpile[RIFLES] ?? 0) > held + CRATES_PER_TICK * 4,
            "rifles to arrive",
            60_000,
          )
          .then(() => true)
          .catch(() => false);
        check(
          arrived,
          `rifles arrive in the buyer's stockpile (${held.toFixed(1)} → ${(buyerPlayer.economy.stockpile[RIFLES] ?? 0).toFixed(1)})`,
        );
        void sellerHeld;
        // Both sides now carry two lanes. The steel lane can scale below its
        // rate if the seller is short (invariant 2), so the test is "more
        // than one lane's worth", not an exact figure.
        check(
          buyerPlayer.economy.tradePointsOut > POINTS_PER_TICK * 1.5,
          `the buyer pays for both lanes (${buyerPlayer.economy.tradePointsOut.toFixed(3)}/tick against ${POINTS_PER_TICK}/tick for one)`,
        );
        check(
          sellerPlayer.economy.tradePointsIn > POINTS_PER_TICK * 1.5,
          `and the seller is paid for both (${sellerPlayer.economy.tradePointsIn.toFixed(3)}/tick) — equipment is priced like the resource, in the only currency there is`,
        );
      }
    }
  }

  if (BREAK === "survives") {
    // Cancelled, and *watched off the wire* until it is actually gone. The
    // first version of this counter-proof slept for a notice period instead
    // and raced the snapshot: the world was killed while the agreement was
    // still standing under notice, came back with it, and the run went on to
    // fail somewhere else entirely. A counter-proof has to remove its subject
    // and then make sure it is removed.
    log("  --break=survives: cancelling before the restart");
    await buyerPlayer.command(
      { kind: "cancel_agreement", agreementId: offerId },
      "break-cancel",
    );
    await buyerPlayer.waitFor(
      (p) => p.agreement(offerId) === undefined,
      "the agreement to be gone before the world is killed",
      Math.max(30_000, (NOTICE_TICKS + 20) * TICK_MS),
    );

    // **And then wait for a snapshot to carry it.** A restore replays the
    // command log up to its last command and no further, so a change made by
    // a *system* after that — the dissolution is one — is rolled back by a
    // kill and simply happens again a few ticks later. That is the world
    // being deterministic, not the world losing anything, and this
    // counter-proof would otherwise race it and fail somewhere else.
    const goneAt = buyerPlayer.tick;
    for (;;) {
      const now = await fetch(HEALTH_URL).then((r) => r.json());
      if (now.lastSnapshotTick >= goneAt) break;
      await sleep(200);
    }
  }

  // The season restart. Nothing is sent by either player from here until the
  // agreement is looked at again — there is no renewal command to send.
  const trustBefore = buyerPlayer.trust[buyer];
  sellerPlayer.close();
  buyerPlayer.close();
  spectator.close();

  log("  killing the world...");
  await compose("kill", "-s", "SIGKILL", "world");
  await compose("up", "-d", "world");
  const after = await waitForHealth();
  log(`  the world came back at tick ${after.tick}, ${after.tickMs} ms a tick`);
  if (after.tickMs > MAX_TICK_MS) {
    log("");
    log("  It came back at the real clock, which means the override did not");
    log("  survive the restart. The rest of this gate waits on an in-game");
    log("  day. Bring the stack up again with WORLD_TICK_MS set and re-run.");
    log("");
    process.exit(2);
  }

  const seller2 = new Player(seller);
  const buyer2 = new Player(buyer);
  await seller2.ready;
  await buyer2.ready;

  const survived = buyer2.agreement(offerId);
  check(
    survived !== undefined && survived.accepted === true,
    `the agreement is still standing after the restart, with nobody having ` +
      `renewed anything (id ${offerId})`,
  );
  check(
    survived?.terms?.resource === RESOURCE &&
      Math.abs((survived?.terms?.resourcePerTick ?? 0) - RESOURCE_PER_TICK) <
        1e-9,
    "and on the same terms it was accepted on",
  );
  await buyer2.waitFor(
    (p) => (p.economy?.tradePointsOut ?? 0) > 0,
    "the flow to resume by itself",
    30_000,
  );
  // Both lanes if the equipment one was staged, and it is the interesting
  // case: the equipment term lives in the snapshot too (decision 0027), so a
  // restart that forgot it would show up here as a half-price flow.
  const lanes = buyer2.agreements.filter(
    (a) => a.type === "trade" && a.parties[1] === buyer && a.accepted,
  ).length;
  check(
    Math.abs(buyer2.economy.tradePointsOut - lanes * POINTS_PER_TICK) < 1e-6,
    `and still moving at the agreed rate, with no action from either player ` +
      `(${lanes} lane(s) at ${POINTS_PER_TICK}/tick, paying ` +
      `${buyer2.economy.tradePointsOut.toFixed(3)})`,
  );

  // Breaking it. The cost is trust, and it is public.
  const trustAtNotice = buyer2.trust[buyer];
  await buyer2.command(
    { kind: "cancel_agreement", agreementId: offerId },
    "notice",
  );
  await buyer2.waitFor(
    (p) => p.agreement(offerId)?.noticeAt !== null,
    "the notice to be recorded",
    30_000,
  );

  if (BREAK === "notified") {
    log("  --break=notified: waiting for the flow to stop before looking");
    for (let i = 0; i < NOTICE_TICKS + 8; i++) await sleep(60);
  }

  // The load-bearing order: the other side knows *while the flow is still
  // running*. That day of warning is what the notice period buys, and it is
  // the only duration §6.5 has.
  // Both halves in one check, and the flow sampled the moment the news
  // lands: "notified before the flow stops" is a claim about the order of two
  // events, so a gate that checked them separately would pass on a world
  // where the notice arrived a day late.
  const told = await seller2
    .waitFor(
      (p) => p.agreement(offerId)?.noticeAt !== null,
      "the other side to be told",
      10_000,
    )
    .then(() => true)
    .catch(() => false);
  const stillMoving =
    (seller2.economy?.tradeResourcePerTick[RESOURCE] ?? 0) < -1e-9;
  check(
    told && stillMoving,
    `the other side is told while the goods are still moving, not after ` +
      `they stop (told: ${told}, still moving: ${stillMoving})`,
  );
  const asSeen = seller2.agreement(offerId);
  check(
    asSeen?.noticeBy === buyer,
    `and is told who gave notice (nation ${asSeen?.noticeBy})`,
  );

  check(
    trustAtNotice - buyer2.trust[buyer] === TRUST_COST_TRADE,
    `breaking it cost exactly ${TRUST_COST_TRADE} trust ` +
      `(${trustAtNotice} to ${buyer2.trust[buyer]})`,
  );
  check(
    seller2.trust[buyer] === buyer2.trust[buyer],
    "and everybody can see it: trust is public",
  );
  check(
    trustBefore === trustAtNotice,
    "while the restart itself cost nobody anything",
  );

  // And then, a day later, it stops.
  await buyer2.waitFor(
    (p) => p.agreement(offerId) === undefined,
    "the notice period to run out",
    // Budgeted from the clock this world is actually running at, with room
    // for the tick that dissolves it and the delta that carries the news.
    Math.max(30_000, (NOTICE_TICKS + 20) * after.tickMs),
  );
  check(
    (buyer2.economy?.tradePointsOut ?? 1) === 0,
    "a day later the flow has stopped and the agreement is gone",
  );

  const health2 = await fetch(HEALTH_URL).then((r) => r.json());
  check(
    health2.healthy === true,
    `the world stayed healthy throughout (${health2.lagMs} ms behind at tick ${health2.tick})`,
  );

  seller2.close();
  buyer2.close();
  log(failures === 0 ? "PASS" : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
