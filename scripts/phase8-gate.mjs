#!/usr/bin/env node
/**
 * The phase-8 gate: air superiority in a zone measurably shifts a ground
 * battle there.
 *
 * CLAUDE.md §8, phase 8. The load-bearing word is **measurably**, and it is
 * the same difficulty phase 5 had: every number on the wire moves for reasons
 * that have nothing to do with the air. A supply figure falls because a front
 * moved, construction falls because a province was lost, a battle is won
 * because the roll came up. So each check below isolates one term and changes
 * nothing else.
 *
 * Three things are shown, cheapest first, because the first two prove the zone
 * machine works at all and the third is the sentence §8 actually asks for:
 *
 * 1. **Interdiction cuts supply.** Bombers over the zone a division stands in,
 *    and its supply figure falls — with no province changing hands, no
 *    division raised or lost, and the same hubs behind it.
 * 2. **Strategic bombing cuts industry.** The same wings, re-tasked, and the
 *    victim's construction and industry per tick fall. Invariant 6, in the one
 *    place a player reads: the economy screen.
 * 3. **Ground support speeds a front.** Since the front became a rate
 *    (invariant 1), what the sky changes is how fast the line moves: the
 *    same front is fought twice for the same fixed window — once with no
 *    air, once with bombers overhead — and the bombers' window has to grind
 *    measurably deeper into the same provinces. Calling an attack off
 *    resets its progress, which is what lets the same ground be fought
 *    twice without either window inheriting the other's work.
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase8-gate.mjs
 *   docker compose up -d
 *
 * And prove it can fail:
 *
 *   node scripts/phase8-gate.mjs --break=grounded   # the wings never fly
 *   node scripts/phase8-gate.mjs --break=idle       # they fly with no mission
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 20;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

const MESSAGE_TIMEOUT_MS = 300_000;

/** BUILDING_TYPES.length, and buildingIndex of the ones this gate reads. */
const BUILDING_COUNT = 10;
const CIVILIAN_FACTORY = 0;
const SUPPLY_HUB = 7;
const AIR_BASE = 5;

/** shared/config/air.ts, for what the checks are allowed to expect. */
const INTERDICTION_MAX = 0.25;
const STRATEGIC_BOMBING_MAX = 0.2;

/** shared/economy/Formations.ts: a bomber wing is this many bombers. */
const BOMBER_WING = 18;

/** How many wings to put up. Enough that saturation is not the limit. */
const WINGS = 5;

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
        this.nations = message.nations;
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
        for (const [province, building, count] of message.buildings) {
          this.buildings[province * BUILDING_COUNT + building] = count;
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

  async waitUntil(predicate, what, timeoutMs) {
    return this.waitFor(predicate, what, timeoutMs)
      .then(() => true)
      .catch(() => false);
  }

  /** Wait for the world to advance this many ticks, whatever happens in them. */
  async ticks(count) {
    const target = this.tick + count;
    await this.waitFor(
      (p) => p.tick >= target,
      `${count} ticks`,
      Math.max(60_000, count * 400),
    );
  }

  building(province, kind) {
    return this.buildings[province * BUILDING_COUNT + kind] ?? 0;
  }

  close() {
    this.socket.close();
  }
}

/**
 * The province graph, read from the artefact both sides load (decision 0006).
 *
 * From the repository rather than over HTTP: the gate needs the map, not the
 * client, and reading the file is reading the map rather than reimplementing
 * the server.
 */
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

/**
 * A pair of nations with a long shared border, and the ground between them.
 *
 * A long border rather than any border: the third check needs several
 * provinces to attack in one air zone, because a single province is one roll
 * and one roll measures luck rather than air.
 */
function frontBetween(spectator, provinces) {
  const best = new Map();
  for (const province of provinces) {
    const defender = spectator.controllers[province.id];
    if (defender <= 0) continue;
    for (const id of province.neighbours) {
      const attacker = spectator.controllers[id];
      if (attacker <= 0 || attacker === defender) continue;
      const key = `${attacker}:${defender}:${province.airZone}`;
      const entry = best.get(key) ?? {
        attacker,
        defender,
        zone: province.airZone,
        targets: new Map(),
      };
      // One staging province per target: the strongest force adjacent is what
      // combat.ts uses, so a second one adds nothing the gate can see.
      if (!entry.targets.has(province.id)) {
        entry.targets.set(province.id, id);
      }
      best.set(key, entry);
    }
  }

  let chosen = null;
  for (const entry of best.values()) {
    if (chosen === null || entry.targets.size > chosen.targets.size) {
      chosen = entry;
    }
  }
  if (chosen === null) throw new Error("this world has no border at all");
  return chosen;
}

/** Open a production line and find out what the reducer called it. */
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

/** Put as many factories on a line as the nation can spare right now. */
async function assignUpTo(player, lineId, want, id) {
  const total = player.economy.militaryFactoriesTotal;
  const elsewhere = player.economy.productionLines
    .filter((line) => line.id !== lineId)
    .reduce((sum, line) => sum + line.factories, 0);
  const possible = Math.max(0, Math.min(want, total - elsewhere));
  if (possible === 0) return 0;
  const ack = await player.command(
    { kind: "assign_factories", lineId, factories: possible },
    id,
  );
  if (!ack.accepted) return 0;
  await player.waitUntil(
    (p) =>
      (p.economy.productionLines.find((l) => l.id === lineId)?.factories ??
        -1) === possible,
    `line ${lineId} to hold ${possible} factories`,
    20_000,
  );
  return possible;
}

/**
 * Build up to `want` military factories, wherever there is a slot.
 *
 * A nation starts with one (STARTING_CAPITAL_BUILDINGS), and one factory
 * turns out a division's rifles in about a thousand ticks. Four turn them out
 * in a quarter of that, and at 300 construction points each against three
 * civilian factories they pay for themselves inside the build-up. A capital is
 * usually out of slots, which is what the phase-6 gate found the slow way.
 */
async function buildFactories(player, provinces, nation, want, tag) {
  const mine = provinces.filter(
    (province) =>
      player.controllers[province.id] === nation &&
      player.owners[province.id] === nation,
  );
  let queued = 0;
  for (const province of mine) {
    if (player.economy.militaryFactoriesTotal + queued >= want) break;
    const ack = await player.command(
      {
        kind: "queue_construction",
        provinceId: province.id,
        building: "military_factory",
      },
      `${tag}-f${province.id}`,
    );
    if (ack.accepted) queued++;
  }
  if (queued === 0) return player.economy.militaryFactoriesTotal;
  log(
    `  ${tag}: building ${queued} more military factor${queued === 1 ? "y" : "ies"}...`,
  );
  await player.waitUntil(
    (p) => p.economy.militaryFactoriesTotal >= want,
    `${want} military factories`,
    BUILD_BUDGET_MS,
  );
  return player.economy.militaryFactoriesTotal;
}

/** Whatever an earlier run left behind. Divisions cost manpower; wings too. */
async function sweep(player) {
  const { divisions, formations, productionLines, attacks } = player.economy;
  // **Standing attacks outlive a run.** An order given by an earlier run is
  // still grinding, still spending equipment and still taking provinces — and
  // the third check counts provinces taken in a window. Left in place it
  // measures the last run as well as this one.
  for (const attack of attacks) {
    await player.command(
      { kind: "cancel_attack", provinceId: attack.province },
      `sweep-a${attack.province}`,
    );
  }
  if (
    divisions.length === 0 &&
    formations.length === 0 &&
    productionLines.length === 0 &&
    attacks.length === 0
  ) {
    return;
  }
  log(
    `  clearing ${divisions.length} division(s), ${formations.length} wing(s) ` +
      `and ${productionLines.length} line(s) left by an earlier run`,
  );
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
  await player.waitUntil(
    (p) =>
      p.economy.divisions.length === 0 &&
      p.economy.formations.length === 0 &&
      p.economy.productionLines.length === 0,
    "the earlier run's units to go",
    30_000,
  );
}

/**
 * How long one fight runs, in ticks: one in-game day.
 *
 * Short on purpose, twice over. With production stood down, every tick of
 * fighting costs both sides equipment and nothing replaces it, so a longer
 * window measures attrition rather than the sky. And the window must end
 * *before* the front completes — the measurement is how deep the line got,
 * and a window long enough for both runs to finish reads 100% both times.
 */
const FIGHT_TICKS = 24;

/**
 * How much deeper the supported window has to grind before the difference
 * counts as the air rather than the luck. The luck roll's noise over a
 * window this size is well under this.
 */
const AIR_MARGIN = 0.03;

/**
 * Divisions per staging province: the combat width, so the border is
 * saturated. A lone division at BAND_LOW against an equipped garrison is a
 * front at parity, and under the rate resolution parity goes nowhere at all
 * — the fight below wants a front that moves, with the sky as the
 * difference in speed.
 */
const STAGE_DIVISIONS = 3;

/** The attacking strength each fight is rebuilt to before it starts. */
const BAND_LOW = 0.8;
/** How long the build-up may take before the gate gives up on the world. */
const BUILD_BUDGET_MS = 600_000;

/**
 * Build the industry this gate needs, on whichever nation is asked.
 *
 * Returns the id of the line, left running, so the caller can retask it.
 */
async function industrialise(player, equipment, want, tag) {
  const lineId = await createLine(player, equipment, tag);
  const on = await assignUpTo(player, lineId, want, `${tag}-assign`);
  log(`  ${tag}: ${on} factor${on === 1 ? "y" : "ies"} making ${equipment}`);
  return lineId;
}

/** Wait until the stockpile holds this much of one equipment type. */
async function stock(player, index, amount, what) {
  await player.waitFor(
    (p) => (p.economy.stockpile[index] ?? 0) >= amount,
    what,
    BUILD_BUDGET_MS,
  );
}

async function main() {
  log("phase-8 gate");

  const state = await health();
  if (state.tickMs > MAX_TICK_MS) {
    log(
      `  this world ticks every ${state.tickMs} ms. This gate plays out a war ` +
        `and would take hours.\n  Restart it with WORLD_TICK_MS=50 docker ` +
        `compose up -d --build, run this, then docker compose up -d.`,
    );
    process.exit(2);
  }
  log(
    `  world ${state.worldId} at tick ${state.tick}, ${state.tickMs} ms a tick`,
  );

  const spectator = new Player(null);
  await spectator.ready;
  const provinces = await provinceData(spectator.map.id);

  const front = frontBetween(spectator, provinces);
  log(
    `  nation ${front.attacker} faces nation ${front.defender} over ` +
      `${front.targets.size} province(s) in air zone ${front.zone}`,
  );
  if (front.targets.size < 3) {
    log(
      "  a world this gate cannot use: no front of three provinces in one zone",
    );
    spectator.close();
    process.exit(2);
  }

  const attacker = new Player(front.attacker);
  const defender = new Player(front.defender);
  await Promise.all([attacker.ready, defender.ready]);
  await sweep(attacker);
  await sweep(defender);

  // -------------------------------------------------------------------------
  // Build-up: an air force, and somebody to fly it against.
  // -------------------------------------------------------------------------

  // The base has to stand where the wings can reach the front from. A
  // province the attacker owns *and* holds, in the front's own zone, is the
  // whole requirement — `ZONE_REACH` does the rest.
  const homeInZone = provinces.filter(
    (province) =>
      attacker.controllers[province.id] === front.attacker &&
      attacker.owners[province.id] === front.attacker &&
      province.airZone === front.zone,
  );
  if (homeInZone.length === 0) {
    log(
      "  a world this gate cannot use: the attacker owns nothing in the zone",
    );
    process.exit(2);
  }

  let base = homeInZone.find(
    (province) => attacker.building(province.id, AIR_BASE) > 0,
  );
  if (base === undefined) {
    // Wherever there is a slot. A capital is usually out of them, which is
    // what the phase-6 gate learned the expensive way.
    for (const province of homeInZone) {
      const ack = await attacker.command(
        {
          kind: "queue_construction",
          provinceId: province.id,
          building: "air_base",
        },
        `base-${province.id}`,
      );
      if (ack.accepted) {
        log(`  building an air base in province ${province.id}...`);
        const built = await attacker.waitUntil(
          (p) => p.building(province.id, AIR_BASE) > 0,
          "the air base to finish",
          BUILD_BUDGET_MS,
        );
        if (built) {
          base = province;
          break;
        }
      }
    }
  }
  if (base === undefined) {
    log("  a world this gate cannot use: nowhere to put an air base");
    process.exit(2);
  }
  log(`  air base in province ${base.id}, zone ${base.airZone}`);

  // Industry first, on both sides. Everything below is waiting for a
  // warehouse to fill, and a nation with one factory fills it four times more
  // slowly than one that spent thirty seconds building three more.
  // Eight, not four. Four made the build-up the longest part of the run and
  // then failed on it: equipping four garrisons is 400 rifles and 48 guns, and
  // artillery is the slow half — it costs four industry points a piece against
  // a rifle's one, so a single factory on it delivers 2.4 a day against a
  // demand near 23. At 300 points each these pay for themselves inside the
  // same run.
  // **Four, not eight.** Eight was tried and was worse: a military factory
  // draws resources whether or not the deposits are there, so doubling them on
  // a steel-poor nation halves `sufficiency` and every line slows down
  // together (invariant 2, working exactly as designed and against the gate).
  // Measured on this map: the attacker ran at 28% sufficiency with eight
  // factories, extracting 12 steel a day against a demand of 43.
  await buildFactories(attacker, provinces, front.attacker, 4, "offence");
  await buildFactories(defender, provinces, front.defender, 4, "defence");

  // Bombers. The expensive part of the run, and the reason the gate wants a
  // fast clock: a wing is 18 aircraft at 14 industry points each.
  const bomberIndex = 4;
  const wanted = WINGS * BOMBER_WING;
  await industrialise(attacker, "aircraft", 12, "bombers");
  log(`  making ${wanted} bombers for ${WINGS} wing(s)...`);
  await stock(attacker, bomberIndex, wanted, `${wanted} bombers in store`);

  const raised = [];
  for (let i = 0; i < WINGS; i++) {
    const before = new Set(attacker.economy.formations.map((f) => f.id));
    const ack = await attacker.command(
      { kind: "raise_formation", provinceId: base.id, template: "wing" },
      `wing-${i}`,
    );
    if (!ack.accepted) {
      log(`  raise_formation refused: ${ack.reason}`);
      break;
    }
    await attacker.waitUntil(
      (p) => p.economy.formations.some((f) => !before.has(f.id)),
      "the wing to appear",
      30_000,
    );
    const wing = attacker.economy.formations.find((f) => !before.has(f.id));
    if (wing !== undefined) raised.push(wing.id);
  }
  if (!check(raised.length > 0, `raised ${raised.length} bomber wing(s)`)) {
    process.exit(1);
  }

  // Let them fill from the warehouse before anything is measured. An empty
  // wing contributes nothing, which would make every check below pass for the
  // wrong reason — or fail for it.
  await attacker.waitFor(
    (p) =>
      p.economy.formations
        .filter((f) => raised.includes(f.id))
        .every((f) => f.strength > 0.9),
    "the wings to draw their aircraft",
    BUILD_BUDGET_MS,
  );
  log(`  ${raised.length} wing(s) at strength, on the ground`);

  /** Put every wing on one mission over the front's zone, or stand them down. */
  const fly = async (mission, tag) => {
    // Owning the sky is part of flying close support: the first wing takes
    // air_superiority so the rest work under a friendly sky rather than the
    // 0.5 stalemate an uncontested zone reads as. It is what a player would
    // order, and it is half the ground_support effect.
    const wanted = new Map(
      raised.map((id, i) => [
        id,
        mission === "ground_support" && i === 0 ? "air_superiority" : mission,
      ]),
    );
    for (const [i, id] of raised.entries()) {
      await attacker.require(
        {
          kind: "assign_formation",
          formationId: id,
          zone: mission === null ? null : front.zone,
          mission: wanted.get(id),
        },
        `${tag}-${i}`,
      );
    }
    await attacker.waitFor(
      (p) =>
        p.economy.formations
          .filter((f) => raised.includes(f.id))
          .every((f) => f.mission === (wanted.get(f.id) ?? null)),
      `the wings to take ${mission ?? "no mission"}`,
      30_000,
    );
  };

  // `--break=grounded` never sends them anywhere; `--break=idle` sends them
  // with no mission. Both leave every other line of this gate untouched, which
  // is what makes them counter-proofs rather than a different run.
  const send = async (mission, tag) => {
    if (BREAK === "grounded") return;
    await fly(BREAK === "idle" ? null : mission, tag);
  };

  // -------------------------------------------------------------------------
  // 1. Interdiction cuts supply.
  // -------------------------------------------------------------------------

  const garrisonAt = [...front.targets.keys()][0];
  await defender.waitFor(
    (p) => p.economy.manpower >= 1000,
    "the defender to have manpower for a division",
    BUILD_BUDGET_MS,
  );
  await defender.require(
    { kind: "raise_division", provinceId: garrisonAt },
    "garrison",
  );
  await defender.waitFor(
    (p) => p.economy.divisions.some((d) => d.provinceId === garrisonAt),
    "the garrison to appear",
    30_000,
  );

  const supplyAt = () =>
    defender.economy.divisions.find((d) => d.provinceId === garrisonAt)?.supply;

  // Settled first: supply moves on its own for a tick or two after a division
  // is raised, because coverage is the nation's whole army against its hubs.
  await defender.ticks(20);
  const supplyBefore = supplyAt();
  const heldBefore = defender.controllers[garrisonAt];

  await send("ground_support", "interdict");
  await defender.ticks(20);
  const supplyAfter = supplyAt();

  check(
    supplyBefore !== undefined && supplyAfter !== undefined,
    `the garrison in province ${garrisonAt} reports its supply`,
  );
  check(
    defender.controllers[garrisonAt] === heldBefore,
    "and nothing changed hands under it, so supply is the only thing measured",
  );
  const cut = supplyBefore > 0 ? 1 - supplyAfter / supplyBefore : 0;
  check(
    supplyAfter < supplyBefore,
    `bombers over the zone cut its supply: ${supplyBefore.toFixed(3)} -> ` +
      `${supplyAfter.toFixed(3)} (${(cut * 100).toFixed(1)}%)`,
  );
  check(
    supplyAfter > 0,
    `and never to nothing — ${(INTERDICTION_MAX * 100).toFixed(0)}% is the cap, ` +
      `and a cut supply line is a worse one, not a severed one`,
  );

  // -------------------------------------------------------------------------
  // 2. Strategic bombing cuts industry.
  // -------------------------------------------------------------------------

  // **Bombing needs a factory in the zone being bombed.** §6.7 scales what
  // factories make, per province, so a defender whose industry all sits in
  // another air zone loses nothing however many bombers are overhead — and
  // the check then measures the geography rather than the mechanic. Which is
  // exactly how it first failed: the front picked a different pair, the
  // defender's capital was elsewhere, and 1.5000 stayed 1.5000.
  const zoneProvinces = provinces.filter(
    (province) =>
      province.airZone === front.zone &&
      defender.controllers[province.id] === front.defender &&
      defender.owners[province.id] === front.defender,
  );
  const hasIndustry = zoneProvinces.some(
    (province) => defender.building(province.id, CIVILIAN_FACTORY) > 0,
  );
  if (!hasIndustry) {
    let queued = false;
    for (const province of zoneProvinces) {
      const ack = await defender.command(
        {
          kind: "queue_construction",
          provinceId: province.id,
          building: "civilian_factory",
        },
        `bombtarget-${province.id}`,
      );
      if (ack.accepted) {
        log(`  building a factory in province ${province.id} to bomb...`);
        queued = await defender.waitUntil(
          (p) => p.building(province.id, CIVILIAN_FACTORY) > 0,
          "the factory to finish",
          BUILD_BUDGET_MS,
        );
        if (queued) break;
      }
    }
    if (!check(queued, "the defender has industry in the zone, to bomb")) {
      process.exit(2);
    }
  }

  await send(null, "stand-down");
  await defender.ticks(20);
  const industryBefore = defender.economy.constructionPerTick;

  await send("ground_support", "bomb");
  await defender.ticks(20);
  const industryAfter = defender.economy.constructionPerTick;

  check(
    industryAfter < industryBefore,
    `bombing the zone cut construction: ${industryBefore.toFixed(4)} -> ` +
      `${industryAfter.toFixed(4)} a tick`,
  );
  check(
    industryAfter > 0,
    `and left the factories running — ${(STRATEGIC_BOMBING_MAX * 100).toFixed(0)}% ` +
      `is the cap, and invariant 2 has no exception for being bombed`,
  );

  // -------------------------------------------------------------------------
  // 3. Ground support decides a fight. §8's own sentence.
  // -------------------------------------------------------------------------

  await send(null, "stand-down-2");

  // Both sides need an army, and the attacker's has to be the weaker one — a
  // front that walks through on tick one proves nothing about the sky. The
  // lever is the warehouse: raising more divisions than there is equipment
  // for leaves every one of them part-equipped, because the stockpile is
  // shared out rather than emptied by whoever asks first (§6.3).
  // **A division is rifles _and_ artillery**, and `divisionStrength` takes the
  // *worst* ratio across its template rather than the average (§6.3): a
  // division with every rifle it wants and no guns is not 90% of a division,
  // it is 0% of one. Producing only rifles leaves every division at zero
  // strength and every fight below it unwinnable by anybody — which is how
  // this gate first failed.
  //
  // **The bomber line has to go first.** Its factories are the same factories
  // the rifles need, and `assign_factories` counts what is already assigned —
  // so asking for rifles while the bombers still hold the plant gets a line
  // with nothing on it and a gate that waits forever for a warehouse nobody
  // is filling. The aircraft are already made and in the wings.
  for (const line of [...attacker.economy.productionLines]) {
    await attacker.command(
      { kind: "remove_production_line", lineId: line.id },
      `retool-${line.id}`,
    );
  }
  await attacker.waitUntil(
    (p) => p.economy.productionLines.length === 0,
    "the bomber line to stand down",
    30_000,
  );
  // Three factories on rifles and one on guns, a side. The split matters more
  // than the totals: a line making only rifles produces divisions that cannot
  // fight, however full the warehouse looks.
  // Six on rifles and two on guns. A division is 100 rifles at one point each
  // and 12 guns at four, so the industry it needs splits about two to one —
  // and a split that ignores the costs leaves one line finished and the other
  // still the bottleneck, with every division stuck at the worse ratio.
  await industrialise(defender, "infantry", 3, "defence-rifles");
  await industrialise(defender, "infantry", 1, "defence-guns");
  const offence = await industrialise(
    attacker,
    "infantry",
    3,
    "offence-rifles",
  );
  await industrialise(attacker, "infantry", 1, "offence-guns");
  if (
    !check(
      attacker.economy.productionLines.find((l) => l.id === offence)
        ?.factories > 0,
      "the attacker's factories retooled from bombers to rifles",
    )
  ) {
    process.exit(1);
  }

  const targets = [...front.targets.entries()].slice(0, 4);
  /** What a garrison has to reach before it counts as one. */
  const GARRISON_STRENGTH = 0.85;

  // **Supply the front first, or the garrisons never finish.**
  //
  // §6.6 wastes an under-supplied division at `SUPPLY_ATTRITION * (1 - supply)`
  // a tick. On this front supply runs about 0.6, which is 0.8% a tick — and
  // 0.8% of a division's 12 guns is 0.096, against an artillery line that
  // makes 0.1. A garrison there sits in equilibrium just below full, forever:
  // it never stops asking for reinforcement, and `reinforce` walks divisions
  // in order, so it starves every garrison behind it. That is the whole reason
  // this gate read `90% 4% 0% 0%` for ten minutes.
  //
  // A supply hub is what a player would build, and it is cheap: 150 points,
  // and the province becomes a supply *source*, so reach there goes to 1 and
  // the attrition goes to nothing.
  // **Both sides**, and the attacker is not an afterthought: its divisions
  // stand at the front too, and once production stops for a measurement window
  // there is nothing replacing what the attrition takes. The first version
  // supplied only the defender and then measured two fights between armies
  // that had wasted to nothing — `divisions at 0%`, twice, and a line that
  // "held" both times because there was nobody attacking it.
  log("  building supply hubs on both sides of the front...");
  const hubWork = [
    [defender, targets.map(([target]) => target)],
    [attacker, [...new Set(targets.map(([, from]) => from))]],
  ];
  for (const [player, wanted] of hubWork) {
    for (const province of wanted) {
      if (player.building(province, SUPPLY_HUB) > 0) continue;
      const ack = await player.command(
        {
          kind: "queue_construction",
          provinceId: province,
          building: "supply_hub",
        },
        `hub-${player.nation}-${province}`,
      );
      if (!ack.accepted) log(`    province ${province}: ${ack.reason}`);
    }
  }
  for (const [player, wanted] of hubWork) {
    await player.waitUntil(
      (p) => wanted.every((province) => p.building(province, SUPPLY_HUB) > 0),
      `nation ${player.nation}'s supply hubs`,
      BUILD_BUDGET_MS,
    );
    log(
      `  nation ${player.nation}: ` +
        `${wanted.filter((p2) => player.building(p2, SUPPLY_HUB) > 0).length} ` +
        `of ${wanted.length} front provinces have a hub`,
    );
  }

  // And bring the bombers home before the build-up: they are still on
  // strategic bombing from the check above, and there is no reason to make the
  // defender's own factories slower while waiting for them.
  await send(null, "stand-down-build");
  log(
    `  garrisoning ${targets.length} province(s) and staging against them...`,
  );

  // **Raised first, equipped after.** Waiting for a full warehouse and only
  // then raising divisions serialises two things that overlap: a division
  // draws from the stockpile every tick it exists, so raising it early means
  // it fills as the factories run rather than after they have finished. The
  // first version waited for 400 rifles before raising anything and timed out
  // on a budget the parallel version finishes inside.
  // **One at a time, each finished before the next is raised.**
  //
  // `reinforce` walks a nation's divisions in order and gives each what it
  // asks for out of what is left, so with production thinner than demand the
  // first division in the list takes everything and the rest sit at zero.
  // Raising all four at once therefore does not share the warehouse between
  // them — it queues them behind one another while looking like no progress
  // is being made at all. It read `99% 4% 0% 0%` for minutes on end.
  //
  // One at a time takes the same total time and makes it legible, and it lets
  // the gate give up on the garrison that actually stalled rather than on all
  // four at once.
  for (const [target] of targets) {
    const strengthAt = (p) =>
      p.economy.divisions.find((d) => d.provinceId === target)?.strength ?? 0;
    if (strengthAt(defender) > GARRISON_STRENGTH) continue;

    if (!defender.economy.divisions.some((d) => d.provinceId === target)) {
      await defender.waitFor(
        (p) => p.economy.manpower >= 1000,
        `manpower for the garrison in ${target}`,
        BUILD_BUDGET_MS,
      );
      await defender.require(
        { kind: "raise_division", provinceId: target },
        `garrison-${target}`,
      );
    }
    const filled = await defender.waitUntil(
      (p) => strengthAt(p) > GARRISON_STRENGTH,
      `the garrison in ${target} to equip`,
      BUILD_BUDGET_MS,
    );
    log(
      `  garrison in ${target}: ${(strengthAt(defender) * 100).toFixed(0)}%` +
        (filled ? "" : " — gave up waiting"),
    );
    if (!filled) break;
  }
  const equipped = targets.every(([target]) =>
    defender.economy.divisions.some(
      (d) => d.provinceId === target && d.strength > GARRISON_STRENGTH,
    ),
  );
  if (
    !check(
      equipped,
      "the garrisons equipped — a front against empty provinces measures nothing",
    )
  ) {
    process.exit(1);
  }
  log(
    `  ${defender.economy.divisions.length} garrison(s), ` +
      `the weakest at ${(
        Math.min(...defender.economy.divisions.map((d) => d.strength)) * 100
      ).toFixed(0)}%`,
  );

  // The attacker: a combat width of divisions per staging province, raised
  // while the warehouse is thin so that none of them is a full division. One
  // at a time, for the reinforcement-queue reason the garrisons are.
  const staging = [...new Set(targets.map(([, from]) => from))];
  const stagedAt = (p, province) =>
    p.economy.divisions.filter((d) => d.provinceId === province).length;
  for (const province of staging) {
    while (stagedAt(attacker, province) < STAGE_DIVISIONS) {
      const have = attacker.economy.divisions.length;
      await attacker.waitFor(
        (p) => p.economy.manpower >= 1000,
        "manpower for an attacking division",
        BUILD_BUDGET_MS,
      );
      const ack = await attacker.command(
        { kind: "raise_division", provinceId: province },
        `stage-${province}-${have}`,
      );
      if (!ack.accepted) {
        log(`  cannot stage more in ${province}: ${ack.reason}`);
        break;
      }
      await attacker.waitUntil(
        (p) => p.economy.divisions.length > have,
        "the attacking division to appear",
        30_000,
      );
    }
  }

  log(`  ${attacker.economy.divisions.length} attacking division(s) staged`);

  // **The same ground, fought twice.** An earlier version split the front in
  // two and fought the halves — one with air, one without — because under the
  // one-roll resolution the first window took every province and left the
  // second nothing to measure. The rate resolution removed that problem and
  // the asymmetry with it: the window ends before any front completes, the
  // attacks are then called off, and calling off loses the progress — so the
  // second window starts from zero on the very same provinces, same terrain,
  // same garrisons. What differs between the windows is the sky, only.

  /** Stand every line down, or put them all back on. */
  const production = async (on, tag) => {
    for (const [i, player] of [attacker, defender].entries()) {
      for (const line of player.economy.productionLines) {
        await player.command(
          {
            kind: "assign_factories",
            lineId: line.id,
            factories: on ? (line.equipment === "infantry" ? 1 : 3) : 0,
          },
          `${tag}-${i}-${line.id}`,
        );
      }
    }
  };

  /**
   * Fight the whole front for one fixed window, and report how deep the
   * line ground in: the mean of each province's furthest progress, 0..1,
   * with a fall counting as 1.
   *
   * The army is rebuilt to `BAND_LOW` with the factories running — and so
   * are the garrisons, because window one hurt them and a second window
   * against weaker defenders would flatter the sky. Then the factories
   * stop, so that a division's strength is the number this gate set rather
   * than whatever the lines made of it mid-fight.
   */
  const fight = async (withAir, tag) => {
    await production(true, `${tag}-on`);
    await attacker.waitUntil(
      (p) =>
        p.economy.divisions.length > 0 &&
        Math.min(...p.economy.divisions.map((d) => d.strength)) >= BAND_LOW,
      "the attacking divisions to come back to strength",
      BUILD_BUDGET_MS,
    );
    await defender.waitUntil(
      (p) =>
        targets.every(
          ([target]) =>
            attacker.controllers[target] === front.attacker ||
            (p.economy.divisions.find((d) => d.provinceId === target)
              ?.strength ?? 0) >= BAND_LOW,
        ),
      "the garrisons to come back to strength",
      BUILD_BUDGET_MS,
    );
    const at = Math.min(...attacker.economy.divisions.map((d) => d.strength));
    await production(false, `${tag}-off`);

    if (withAir) await send("ground_support", `${tag}-air`);
    else await send(null, `${tag}-noair`);

    // Only provinces the defender still holds are worth fighting over.
    const contested = targets.filter(
      ([target]) => attacker.controllers[target] !== front.attacker,
    );
    if (contested.length === 0) return null;

    for (const [target] of contested) {
      await attacker.command(
        { kind: "claim_province", provinceId: target },
        `${tag}-front-${target}`,
      );
    }

    // Watch each front's progress and keep the deepest reading. Progress is
    // on the wire (`economy.attacks`), so this is the number the player's
    // own screen would show.
    const startTick = attacker.tick;
    const deepest = new Map();
    while (attacker.tick < startTick + FIGHT_TICKS) {
      for (const [target] of contested) {
        if (attacker.controllers[target] === front.attacker) {
          deepest.set(target, 1);
        } else {
          const standing = attacker.economy?.attacks.find(
            (a) => a.province === target,
          );
          if (standing !== undefined) {
            deepest.set(
              target,
              Math.max(deepest.get(target) ?? 0, standing.progress),
            );
          }
        }
      }
      await sleep(20);
    }

    // Call the window's attacks off. Cancelling loses the progress, which is
    // exactly what lets the next window fight the same ground from zero.
    for (const [target] of contested) {
      if (attacker.controllers[target] === front.attacker) continue;
      await attacker.command(
        { kind: "cancel_attack", provinceId: target },
        `${tag}-stop-${target}`,
      );
    }

    const scores = contested.map(([target]) => deepest.get(target) ?? 0);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    log(
      `  ${withAir ? "with bombers   " : "without bombers"}: the line gave ` +
        `${scores.map((score) => `${(score * 100).toFixed(0)}%`).join(", ")}` +
        ` — mean ${(mean * 100).toFixed(1)}%, ` +
        `${scores.filter((score) => score >= 1).length} of ` +
        `${contested.length} fell, divisions at ${(at * 100).toFixed(0)}%`,
    );
    return mean;
  };

  const quiet = await fight(false, "quiet");
  const supported = await fight(true, "supported");

  if (quiet === null || supported === null) {
    fail("a world this gate cannot use: the front was already lost");
  } else {
    check(
      supported > quiet + AIR_MARGIN,
      `air superiority shifted the ground battle: the same front gave way ` +
        `${(quiet * 100).toFixed(1)}% deep in ${FIGHT_TICKS} ticks with no ` +
        `air, and ${(supported * 100).toFixed(1)}% with bombers over it`,
    );
  }

  const healthy = await health();
  check(
    healthy.healthy && healthy.lagMs < 1000,
    `the world stayed healthy throughout (${healthy.lagMs} ms behind at tick ${healthy.tick})`,
  );

  log(failures === 0 ? "PASS" : "FAIL");
  process.exitCode = failures === 0 ? 0 : 1;
  attacker.close();
  defender.close();
  spectator.close();
}

main().catch((error) => {
  log(`  FAIL  ${error.message}`);
  process.exit(1);
});
