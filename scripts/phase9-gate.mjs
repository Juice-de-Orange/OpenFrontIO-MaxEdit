/**
 * Phase-9 gate: naval zones and convoys, played over a live WebSocket.
 *
 * CLAUDE.md §8: "cutting an opponent's convoy routes starves an overseas
 * province of supply *and* cuts their trade income, without any land
 * engagement. A naval invasion successfully lands and holds a beachhead."
 *
 * The staging is the whole difficulty, as it was for phase 8, so the order
 * is chosen to make each step pay for the next:
 *
 * 1. An island nation and a mainland shore across one sea zone. Island,
 *    because a beachhead on a landmass you can walk to is a *land* route and
 *    the sea checks would measure a road.
 * 2. The defender builds the port on its own beach first — buildings belong
 *    to the province, so the invader inherits a working harbour and §6.6's
 *    "port on both ends" holds the tick the beach falls.
 * 3. The invasion crosses visibly (the public `invasions` list), lands at
 *    reduced strength on the open beach, and the beachhead then *is* the
 *    overseas province the starvation half measures.
 * 4. Convoys come from a dockyard line, submarines from another; the raiders
 *    take the route's own zone, and supply, the convoy stock and the trade
 *    flow are read off the wire before and after.
 *
 * Run against a fast world (fresh: `docker compose down -v`):
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase9-gate.mjs
 *
 * And prove it can fail:
 *
 *   node scripts/phase9-gate.mjs --break=moored   # the raiders never sail
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 * `tests/GateProtocolVersion.test.ts` reads this line and compares it.
 */
const PROTOCOL_VERSION = 21;

/** Above this the gate would run for hours; say so instead. */
const MAX_TICK_MS = 200;

const MESSAGE_TIMEOUT_MS = 300_000;

/** BUILDING_TYPES.length, and buildingIndex of the ones this gate reads. */
const BUILDING_COUNT = 10;
const NAVAL_BASE = 6;
const SUPPLY_HUB = 7;

/** shared/config/naval.ts, for what the checks are allowed to expect. */
const SEA_SUPPLY_FLOOR = 0.25;
const INVASION_TICKS_PER_ZONE = 12;

/** shared/config/rates.ts: a warehouse holds this much of one resource. */
const RESOURCE_CAP = 5000;

/** shared/economy/Formations.ts: a flotilla is this many submarines. */
const SUBMARINE_FLOTILLA = 10;

/** How many dockyards each side builds. Ramp time dominates everything. */
const YARDS = 3;

/** Convoys the island runs up before anything is measured. */
const CONVOY_STOCK = 40;

/** How long the build-up may take before the gate gives up on the world. */
const BUILD_BUDGET_MS = 600_000;

/** Ticks the raid is given to show up in the supply figure. */
const RAID_SETTLE_TICKS = 40;

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
    this.invasions = [];
    this.agreements = [];
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
        this.invasions = message.invasions;
        this.agreements = message.agreements;
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
        this.invasions = message.invasions;
        this.agreements = message.agreements;
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
 * The landmass a nation's territory sits on, as a set of province ids —
 * a breadth-first walk over the land graph from everything it controls.
 */
function landmassOf(controllers, provinces, nation) {
  const seen = new Set();
  const queue = [];
  for (const province of provinces) {
    if (controllers[province.id] !== nation) continue;
    seen.add(province.id);
    queue.push(province.id);
  }
  const byId = new Map(provinces.map((province) => [province.id, province]));
  for (let head = 0; head < queue.length; head++) {
    for (const next of byId.get(queue[head]).neighbours) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * A stage this world actually offers: an island nation, a mainland beach
 * across one shared sea zone, and a trade partner on the far landmass.
 *
 * One shared sea zone, deliberately: the gate cannot read the sea-zone
 * adjacency out of the artefact without re-implementing the decoder, and a
 * one-zone crossing exercises every mechanic the multi-zone one does — the
 * route has a zone to raid, the invasion has a zone to control.
 */
function findStage(spectator, provinces) {
  const nations = new Set(spectator.controllers.filter((nation) => nation > 0));
  let best = null;
  for (const island of nations) {
    const mass = landmassOf(spectator.controllers, provinces, island);
    const shore = provinces.filter(
      (province) =>
        spectator.controllers[province.id] === island &&
        province.seaZone !== null,
    );
    // Room to build on: a one-province islet cannot host a hub, a port and
    // three dockyards, and the first candidate this search returned was
    // exactly that. Capacity first, then the crossing.
    if (shore.length < 3) continue;
    const zones = new Set(shore.map((province) => province.seaZone));

    // Everything on another landmass whose coast touches one of our zones.
    const across = provinces.filter(
      (province) =>
        !mass.has(province.id) &&
        province.seaZone !== null &&
        zones.has(province.seaZone) &&
        spectator.controllers[province.id] > 0 &&
        spectator.controllers[province.id] !== island,
    );
    if (across.length === 0) continue;

    // The beach: prefer one with a free slot for the defender's port.
    const beach = across.find((province) => province.buildingSlots >= 2);
    if (beach === undefined) continue;
    const defender = spectator.controllers[beach.id];

    // **A trade partner with no land path to the island at all.** Not merely
    // one with a coast across the water: a nation can hold ground on both
    // landmasses, and then `tradeRouteBetween` finds a land route, the trade
    // needs no convoys, and the raiding half of this gate measures nothing —
    // which is exactly what it did on the map with the real borders, where
    // the largest island's neighbour turned out to be reachable overland.
    const strangers = new Set();
    for (const nation of new Set(
      across.map((province) => spectator.controllers[province.id]),
    )) {
      const onOurMass = provinces.some(
        (province) =>
          spectator.controllers[province.id] === nation &&
          mass.has(province.id),
      );
      if (!onOurMass) strangers.add(nation);
    }
    if (!strangers.has(defender)) continue;
    const partner = [...strangers].find((nation) => nation !== defender);

    const home = shore.find((province) => province.seaZone === beach.seaZone);
    if (home === undefined) continue;

    const found = {
      island,
      defender,
      partner: partner ?? defender,
      home,
      beach,
      shoreSize: shore.length,
    };
    if (best === null || found.shoreSize > best.shoreSize) best = found;
  }
  return best;
}

/** Queue one building somewhere it fits, trying the given provinces. */
async function buildOn(player, candidates, building, tag) {
  for (const province of candidates) {
    const ack = await player.command(
      { kind: "queue_construction", provinceId: province, building },
      `${tag}-${province}`,
    );
    if (ack.accepted) return province;
  }
  return null;
}

/** Build up to `want` dockyards on this nation's own coast. */
async function buildYards(player, provinces, nation, want, tag, avoid = -1) {
  const coast = provinces
    .filter(
      (province) =>
        player.controllers[province.id] === nation &&
        player.owners[province.id] === nation &&
        province.seaZone !== null,
    )
    // The home port's slots are spoken for (hub + naval base), so it goes
    // last and only carries a yard if nowhere else can.
    .sort((a, b) => (a.id === avoid ? 1 : 0) - (b.id === avoid ? 1 : 0));
  let queued = 0;
  let lastReason = null;
  for (const province of coast) {
    if (player.economy.dockyardsTotal + queued >= want) break;
    const ack = await player.command(
      {
        kind: "queue_construction",
        provinceId: province.id,
        building: "military_factory",
      },
      `${tag}-y${province.id}`,
    );
    if (ack.accepted) queued++;
    else lastReason = ack.reason;
  }
  log(
    `  ${tag}: ${queued} dockyard(s) queued against ${coast.length} coastal ` +
      `province(s)` +
      (lastReason === null ? "" : ` (last refusal: ${lastReason})`),
  );
  if (queued === 0 && player.economy.dockyardsTotal < want) {
    log(
      `  a world this gate cannot use: ${tag} cannot build a single dockyard`,
    );
    process.exit(2);
  }
  await player.waitUntil(
    (p) => p.economy.dockyardsTotal >= want,
    `${want} dockyards`,
    BUILD_BUDGET_MS,
  );
  return player.economy.dockyardsTotal;
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

/** Whatever an earlier run left behind. Divisions cost manpower; fleets too. */
async function sweep(player) {
  const { divisions, formations, productionLines, attacks } = player.economy;
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
    `  clearing ${divisions.length} division(s), ${formations.length} ` +
      `formation(s) and ${productionLines.length} line(s) left by an earlier run`,
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

const CONVOY_INDEX = 6; // EQUIPMENT_TYPES order: convoy is index 6
const SUBMARINE_INDEX = 7;

async function main() {
  const state = await health();
  log("phase-9 gate");
  log(
    `  world ${state.worldId} at tick ${state.tick}, ${state.tickMs} ms a tick`,
  );
  if (state.tickMs > MAX_TICK_MS) {
    log(
      `  this world ticks every ${state.tickMs} ms; the build-up alone would` +
        ` take hours. Restart it faster:\n` +
        `    WORLD_TICK_MS=50 docker compose up -d --build`,
    );
    process.exit(2);
  }
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const spectator = new Player(null);
  await spectator.ready;
  const provinces = await provinceData(spectator.map.id);

  const stage = findStage(spectator, provinces);
  if (stage === null) {
    log(
      "  a world this gate cannot use: no island nation faces a mainland " +
        "coast across a shared sea zone",
    );
    process.exit(2);
  }
  const { island, defender, home, beach } = stage;
  log(
    `  nation ${island} (an island) faces nation ${defender}'s coast at ` +
      `province ${beach.id}, over sea zone ${beach.seaZone} — enemy, trade ` +
      `partner and raider in one, as a war across a strait tends to make you`,
  );

  const attacker = new Player(island);
  const victim = new Player(defender);
  await attacker.ready;
  await victim.ready;
  await sweep(attacker);
  await sweep(victim);

  // -------------------------------------------------------------------------
  // Build-up. The island: a source port at home, dockyards, convoys. The
  // defender: the port on its own beach (the invader inherits it — buildings
  // belong to the province), dockyards, submarines.
  // -------------------------------------------------------------------------

  if (attacker.building(home.id, SUPPLY_HUB) === 0) {
    await buildOn(attacker, [home.id], "supply_hub", "hub");
  }
  if (attacker.building(home.id, NAVAL_BASE) === 0) {
    await buildOn(attacker, [home.id], "naval_base", "port");
  }
  if (victim.building(beach.id, NAVAL_BASE) === 0) {
    await buildOn(victim, [beach.id], "naval_base", "beachport");
  }

  await buildYards(attacker, provinces, island, YARDS, "island", home.id);
  await buildYards(victim, provinces, defender, YARDS, "defender");

  const convoyLine = await createLine(attacker, "ships", "convoys");
  await attacker.require(
    { kind: "assign_factories", lineId: convoyLine, factories: YARDS },
    "convoys-assign",
  );
  const subLine = await createLine(victim, "ships", "subs");
  await victim.require(
    { kind: "assign_factories", lineId: subLine, factories: YARDS },
    "subs-assign",
  );
  // Submarines drink oil, and a defender picked for its coastline may pump
  // none — the first run of this gate found nation 7 at sufficiency 0.000
  // with a full steel store. The world market is §6.5's answer for exactly
  // this nation, so the gate uses it the way a player would.
  await victim.require(
    { kind: "set_market_order", resource: "material", perTick: 0.5 },
    "subs-oil",
  );

  log(
    `  making ${CONVOY_STOCK} convoys and ${2 * SUBMARINE_FLOTILLA} ` +
      `submarines...`,
  );
  await attacker.waitFor(
    (p) => p.economy.stockpile[CONVOY_INDEX] >= CONVOY_STOCK,
    "the island's convoys",
    BUILD_BUDGET_MS,
  );
  await victim.waitFor(
    (p) => p.economy.stockpile[SUBMARINE_INDEX] >= 2 * SUBMARINE_FLOTILLA,
    "the defender's submarines",
    BUILD_BUDGET_MS,
  );
  // The oil is bought and the boats are built; the standing order would go
  // on trading construction points for oil nobody needs — which is exactly
  // the budget the raiders' harbour is about to be built from.
  await victim.require(
    { kind: "set_market_order", resource: "material", perTick: 0 },
    "subs-oil-stop",
  );
  ok(
    `the island holds ${attacker.economy.stockpile[CONVOY_INDEX].toFixed(0)} ` +
      `convoys and the defender ${victim.economy.stockpile[
        SUBMARINE_INDEX
      ].toFixed(0)} submarines — all of it dockyard time (§6.3)`,
  );

  // -------------------------------------------------------------------------
  // The ports before the wire: the defender's own beach carries its harbour.
  // -------------------------------------------------------------------------
  await attacker.waitFor(
    (p) =>
      p.building(home.id, NAVAL_BASE) > 0 &&
      p.building(home.id, SUPPLY_HUB) > 0,
    "the island's home port",
    BUILD_BUDGET_MS,
  );
  await victim.waitFor(
    (p) => p.building(beach.id, NAVAL_BASE) > 0,
    "the beach's port",
    BUILD_BUDGET_MS,
  );

  // -------------------------------------------------------------------------
  // The trade, before the landing — deliberately. A beachhead joins the two
  // landmasses, the route resolver then rightly calls the pair a *land*
  // route, and a land trade needs no convoys and fears no submarine. The
  // seaborne half of §8's sentence has to be measured while the sea is the
  // only way between them. The partner is the defender itself: their coasts
  // share the beach's zone by construction, so the raiders and the route
  // cannot miss each other.
  // -------------------------------------------------------------------------
  const resource = ["material"].find(
    (kind) =>
      victim.economy.resources[kind] > 200 &&
      attacker.economy.resources[kind] < RESOURCE_CAP - 500,
  );
  if (resource === undefined) {
    log(
      "  a world this gate cannot use: no resource the defender holds fits " +
        "in the island's warehouse",
    );
    process.exit(2);
  }
  log(`  the defender sells ${resource}; the island has room for it`);
  const offer = await victim.command(
    {
      kind: "propose_agreement",
      to: island,
      type: "trade",
      terms: { resource, resourcePerTick: 0.5, pointsPerTick: 0.25 },
    },
    "offer",
  );
  check(
    offer.accepted,
    `a trade across open water is offerable now (${offer.reason ?? "accepted"})`,
  );
  await attacker.waitFor(
    (p) =>
      p.agreements.some(
        (a) => a.type === "trade" && a.parties[0] === defender && !a.accepted,
      ),
    "the offer to arrive",
    30_000,
  );
  const pendingOffer = attacker.agreements.find(
    (a) => a.type === "trade" && a.parties[0] === defender && !a.accepted,
  );
  await attacker.require(
    { kind: "accept_agreement", agreementId: pendingOffer.id },
    "accept",
  );
  await attacker.waitFor(
    (p) => p.economy.tradeResourcePerTick[resource] > 0,
    `the ${resource} to start moving over the water`,
    60_000,
  );
  const flowBefore = attacker.economy.tradeResourcePerTick[resource];
  ok(
    `the sea trade moves: ${flowBefore.toFixed(3)} ${resource} a tick ` +
      `arrives on the island's convoys`,
  );

  // -------------------------------------------------------------------------
  // The raiders. Production stops so the convoy stock reading is closed.
  // The route between the two coasts runs over one of the zones they share;
  // with two flotillas, either both watch the one shared zone — one owning
  // the water, one hunting — or they split across two.
  // -------------------------------------------------------------------------
  await attacker.require(
    { kind: "assign_factories", lineId: convoyLine, factories: 0 },
    "convoys-halt",
  );

  const islandZones = new Set(
    provinces
      .filter(
        (province) =>
          attacker.controllers[province.id] === island &&
          province.seaZone !== null,
      )
      .map((province) => province.seaZone),
  );
  const shared = [
    ...new Set(
      provinces
        .filter(
          (province) =>
            victim.controllers[province.id] === defender &&
            province.seaZone !== null &&
            islandZones.has(province.seaZone),
        )
        .map((province) => province.seaZone),
    ),
  ];
  if (shared.length > 2) {
    log(
      `  a world this gate cannot use: the coasts share ${shared.length} ` +
        `sea zones and two flotillas cannot watch them all`,
    );
    process.exit(2);
  }

  const raiderBase = provinces.find(
    (province) =>
      victim.controllers[province.id] === defender &&
      victim.owners[province.id] === defender &&
      province.seaZone === beach.seaZone &&
      province.id !== beach.id,
  );
  const basedAt =
    raiderBase !== undefined && victim.building(raiderBase.id, NAVAL_BASE) === 0
      ? await buildOn(victim, [raiderBase.id], "naval_base", "raiderport")
      : (raiderBase?.id ?? null);
  if (basedAt === null) {
    log(
      "  a world this gate cannot use: the defender has no second coast on " +
        "the route's zone",
    );
    process.exit(2);
  }
  await victim.waitFor(
    (p) => p.building(basedAt, NAVAL_BASE) > 0,
    "the raiders' harbour",
    BUILD_BUDGET_MS,
  );

  await victim.waitFor(
    (p) => p.economy.manpower >= 1000,
    "manpower for the flotillas",
    BUILD_BUDGET_MS,
  );
  for (const tag of ["hunters", "cover"]) {
    await victim.require(
      {
        kind: "raise_formation",
        template: "fleet",
        provinceId: basedAt,
      },
      `raise-${tag}`,
    );
  }
  await victim.waitFor(
    (p) =>
      p.economy.formations.length >= 2 &&
      p.economy.formations.every((f) => f.strength >= 0.95),
    "the flotillas to fit out",
    BUILD_BUDGET_MS,
  );
  const [hunters, cover] = victim.economy.formations;

  const sailRaiders = async (tag) => {
    if (BREAK === "moored") {
      log(`  --break=moored: the flotillas stay in harbour (${tag})`);
      return;
    }
    await victim.require(
      {
        kind: "assign_formation",
        formationId: hunters.id,
        zone: shared[0],
        mission: "raiding",
      },
      `${tag}-hunters`,
    );
    await victim.require(
      {
        kind: "assign_formation",
        formationId: cover.id,
        zone: shared[1] ?? shared[0],
        mission: shared.length > 1 ? "raiding" : "patrol",
      },
      `${tag}-cover`,
    );
    log(
      `  flotillas over shared sea zone(s) ${shared.join(", ")}: the ` +
        `island's convoys are being hunted (${tag})`,
    );
  };
  const harbourRaiders = async (tag) => {
    if (BREAK === "moored") return;
    for (const [name, formation] of [
      ["hunters", hunters],
      ["cover", cover],
    ]) {
      await victim.require(
        {
          kind: "assign_formation",
          formationId: formation.id,
          zone: null,
          mission: null,
        },
        `${tag}-${name}`,
      );
    }
  };

  // A quiet window first: with the yards silent the stock still thins from
  // wear, and a sinking check that cannot tell wear from war would pass with
  // the raiders in harbour — the first counter-proof run showed exactly
  // that. The raid has to empty the warehouse measurably faster than the
  // sea alone does.
  const stockStart = attacker.economy.stockpile[CONVOY_INDEX];
  await attacker.ticks(RAID_SETTLE_TICKS);
  const stockQuiet = attacker.economy.stockpile[CONVOY_INDEX];
  const wearLoss = stockStart - stockQuiet;

  await sailRaiders("trade-window");
  const stockBefore = attacker.economy.stockpile[CONVOY_INDEX];
  await attacker.ticks(RAID_SETTLE_TICKS);
  const stockAfter = attacker.economy.stockpile[CONVOY_INDEX];
  const raidLoss = stockBefore - stockAfter;
  const flowRaided = attacker.economy.tradeResourcePerTick[resource];

  check(
    flowRaided < flowBefore - 1e-6,
    `raiding the route cut the trade income: ${flowBefore.toFixed(3)} -> ` +
      `${flowRaided.toFixed(3)} ${resource} a tick, with no land engagement`,
  );
  check(
    raidLoss > 2 * wearLoss && raidLoss > 0,
    `the convoys themselves are being sunk: ${raidLoss.toFixed(2)} lost ` +
      `under the raid against ${wearLoss.toFixed(2)} to wear alone in the ` +
      `same window, with the yards silent`,
  );

  // -------------------------------------------------------------------------
  // The landing. The raiders go home first — §6.8 gates an invasion on sea
  // control, and that is not a rule this gate wants to fight, it is a rule
  // it demonstrates by obeying. A division needs manpower and nothing else:
  // an empty one can cross and take an open beach, and its supply figure is
  // what the starvation half reads, not its strength.
  // -------------------------------------------------------------------------
  await harbourRaiders("crossing");
  await attacker.ticks(2);

  await attacker.waitFor(
    (p) => p.economy.manpower >= 1000,
    "manpower for the landing force",
    BUILD_BUDGET_MS,
  );
  await attacker.require(
    { kind: "raise_division", provinceId: home.id },
    "landing-raise",
  );
  await attacker.waitFor(
    (p) => p.economy.divisions.some((d) => d.provinceId === home.id),
    "the landing force to muster",
    30_000,
  );
  const force = attacker.economy.divisions.find(
    (d) => d.provinceId === home.id,
  );

  const sail = await attacker.command(
    { kind: "naval_invade", divisionId: force.id, provinceId: beach.id },
    "sail",
  );
  if (
    !check(
      sail.accepted,
      `the invasion put to sea (${sail.reason ?? "accepted"})`,
    )
  ) {
    process.exit(1);
  }

  await spectator.waitFor(
    (p) => p.invasions.some((i) => i.attacker === island && i.to === beach.id),
    "the crossing to appear on the public wire",
    30_000,
  );
  ok(
    "the crossing is on the wire for everyone — a spectator can watch it " +
      "coming, which is the §6.8 defence",
  );

  const sailedAt = attacker.tick;
  await attacker.waitFor(
    (p) => p.controllers[beach.id] === island,
    "the landing",
    60_000,
  );
  const crossing = attacker.tick - sailedAt;
  check(
    crossing >= INVASION_TICKS_PER_ZONE - 2,
    `the crossing took ${crossing} tick(s) — an operation, not a teleport ` +
      `(${INVASION_TICKS_PER_ZONE} a zone)`,
  );
  ok(`the beach at province ${beach.id} is the island's beachhead now`);

  // -------------------------------------------------------------------------
  // The overseas province reports its supply, and the raiders return.
  // -------------------------------------------------------------------------
  await attacker.ticks(20);
  const supplyAt = () =>
    attacker.economy.divisions.find((d) => d.provinceId === beach.id)?.supply;
  const baseline = supplyAt();
  if (baseline === undefined) {
    fail("the landed division reports no supply figure at all");
    process.exit(1);
  }
  check(
    baseline > SEA_SUPPLY_FLOOR,
    `the beachhead is supplied over the sea: ${(baseline * 100).toFixed(1)}% ` +
      `— above the no-convoy floor of ${SEA_SUPPLY_FLOOR * 100}%, so the ` +
      `convoys are carrying it`,
  );

  await sailRaiders("supply-window");
  await attacker.ticks(RAID_SETTLE_TICKS);
  const supplyRaided = supplyAt();

  check(
    supplyRaided !== undefined && supplyRaided < baseline - 0.01,
    `raiding the route starved the beachhead: supply ` +
      `${(baseline * 100).toFixed(1)}% -> ${((supplyRaided ?? 0) * 100).toFixed(1)}%`,
  );
  check(
    supplyRaided !== undefined && supplyRaided > 0,
    `and never to nothing — a cut convoy line is a worse one, not a severed ` +
      `one (invariant 2)`,
  );
  check(
    attacker.controllers[beach.id] === island,
    "and the beachhead held through all of it",
  );

  const healthy = await health();
  check(
    healthy.healthy && healthy.lagMs < 1000,
    `the world stayed healthy throughout (${healthy.lagMs} ms behind at tick ${healthy.tick})`,
  );

  log(failures === 0 ? "PASS" : "FAIL");
  process.exitCode = failures === 0 ? 0 : 1;
  attacker.close();
  victim.close();
  spectator.close();
}

main().catch((error) => {
  log(`  FAIL  ${error.message}`);
  process.exit(1);
});
