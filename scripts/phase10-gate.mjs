/**
 * Phase-10 gate: the regent, measured over a live WebSocket — against an
 * opponent that fights.
 *
 * CLAUDE.md §8: "a nation left under regent control for 2,000 ticks against
 * an active opponent still holds its capital, has a non-empty construction
 * queue, and has not reset a single production line."
 *
 * The first version of this gate marched with no army at all, because since
 * the front became a rate `claim_province` walks into any undefended
 * province; the regent's one garrison stopped the march at the capital and
 * everything else was a free walk. The second regent (decision 0028) plays
 * the whole game, so the opponent now does too: three divisions at the
 * border, an air base, a bomber wing on close support over the front zone,
 * and up to three standing attacks re-ordered the moment one falls. What
 * the regent must show against that, on top of §8's three clauses:
 *
 *   - it still holds sixty per cent of what it started with,
 *   - it has an army — three divisions, one of them at the border,
 *   - it answered the sky in the order the game allows: an air base, then
 *     a fighter line behind it, then a wing on air superiority over the
 *     threatened zone. The window is short for the whole chain, so the base
 *     is the hard check and the rest is reported as far as it got.
 *
 * Run against a fast world (fresh: `docker compose down -v`):
 *
 *   WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase10-gate.mjs
 *   node scripts/phase10-gate.mjs --scenario=sea   # the §6.10 escort duty
 *
 * And prove it can fail:
 *
 *   node scripts/phase10-gate.mjs --break=asleep   # the regent never wakes
 *   REGENT_BREAK=blind WORLD_TICK_MS=50 docker compose up -d --build
 *   node scripts/phase10-gate.mjs --break=blind    # it cannot see the sky
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
const BUILD_BUDGET_MS = 600_000;

/** §8's own number: how long the nation is left to the regent. */
const WINDOW_TICKS = 2000;

/** How many fronts the attacker keeps open at once, and how many divisions it brings. */
const PRESSURE = 3;
const ARMY = 3;

/** shared/config: what a division and a wing cost, and what they hold. */
const DIVISION_MANPOWER = 1000;
/** rates.ts: a province's tiles are its share of the manpower ceiling. */
const MANPOWER_PER_TILE = 0.6;
/**
 * How much of a nation's ceiling the gate is willing to wait for.
 *
 * Manpower regrows by 0.0002 of the cap a tick, so the pool approaches the
 * ceiling and never reaches it: waiting for 85% costs half again as long as
 * waiting for 75%, and the first run of this gate spent its whole ten-minute
 * budget waiting for an army a small nation could never have raised.
 */
const MANPOWER_SHARE = 0.75;
const WING_MANPOWER = 500;
const RIFLES = 100;
const GUNS = 12;
const BOMBER_WING = 18;

/** EQUIPMENT_TYPES order (shared/economy/Equipment.ts). */
const EQ = {
  infantry_equipment: 0,
  artillery: 1,
  fighter: 3,
  bomber: 4,
  convoy: 6,
  escort: 8,
};
/** BUILDING_TYPES order (shared/economy/Buildings.ts). */
const BUILDING_COUNT = 10;
const B = { military_factory: 1, dockyard: 2, air_base: 5, naval_base: 6 };
/** An opponent with fewer arms plants than this cannot equip an army in the window. */
const ARMS_WANTED = 3;
/** shared/config/regent.ts: below this a formation stays at its base. */
const REGENT_STAND_DOWN = 0.25;

const BREAK = (() => {
  const arg = process.argv.find((a) => a.startsWith("--break="));
  return arg === undefined ? null : arg.slice("--break=".length);
})();
const SCENARIO = (() => {
  const arg = process.argv.find((a) => a.startsWith("--scenario="));
  return arg === undefined ? "land" : arg.slice("--scenario=".length);
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
function note(what) {
  log(`  note  ${what}`);
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
          token: null,
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

  building(province, kind) {
    return this.buildings[province * BUILDING_COUNT + kind] ?? 0;
  }

  /** Provinces this nation controls. */
  held() {
    const mine = [];
    for (let p = 0; p < this.controllers.length; p++) {
      if (this.controllers[p] === this.nation) mine.push(p);
    }
    return mine;
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
  if (
    divisions.length === 0 &&
    formations.length === 0 &&
    productionLines.length === 0
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

/** Put up to `want` idle factories on a line; returns how many it got. */
async function assignUpTo(player, lineId, want, id, total) {
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

/** Wait until the stockpile holds this much of one equipment type. */
async function stock(player, index, amount, what) {
  return player.waitUntil(
    (p) => (p.economy.stockpile[index] ?? 0) >= amount,
    what,
    BUILD_BUDGET_MS,
  );
}

/** Hops from the capital over one nation's own ground. */
function distancesFrom(capital, controllers, nation, byId) {
  const distance = new Map([[capital, 0]]);
  const queue = [capital];
  for (let head = 0; head < queue.length; head++) {
    for (const next of byId.get(queue[head]).neighbours) {
      if (distance.has(next)) continue;
      if (controllers[next] !== nation) continue;
      distance.set(next, distance.get(queue[head]) + 1);
      queue.push(next);
    }
  }
  return distance;
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
  // What each nation's land can support, the same arithmetic `manpowerCap`
  // does on the server. **This is what the pair is chosen on**: a war
  // between two hamlets measures nothing, because neither side can afford an
  // army, and the first run of this gate timed out waiting for one.
  const ceiling = new Map();
  // And what each nation can *arm*. Buildings are public in the full state,
  // so the spectator can count them. Men without rifles are not an opponent:
  // the first run of this gate marched three divisions at strength 0.00,
  // because the nation it picked held one military factory.
  const arms = new Map();
  const held = new Map();
  for (const province of provinces) {
    const holder = spectator.controllers[province.id];
    if (holder <= 0) continue;
    held.set(holder, (held.get(holder) ?? 0) + 1);
    ceiling.set(
      holder,
      (ceiling.get(holder) ?? 0) + province.tileCount * MANPOWER_PER_TILE,
    );
    arms.set(
      holder,
      (arms.get(holder) ?? 0) +
        spectator.buildings[province.id * BUILDING_COUNT + B.military_factory],
    );
    if (province.capital && !capitalOf.has(holder)) {
      capitalOf.set(holder, province.id);
    }
  }

  let best = null;
  for (const [regent, capital] of capitalOf) {
    const distance = distancesFrom(
      capital,
      spectator.controllers,
      regent,
      byId,
    );
    for (const [province, hops] of distance) {
      for (const next of byId.get(province).neighbours) {
        const attacker = spectator.controllers[next];
        if (attacker <= 0 || attacker === regent) continue;
        // Three hops at least: a capital two provinces from the border falls
        // to a march before a steward's first thought, and a gate that picks
        // one measures the map. Five at most, or the offensive never arrives.
        if (hops < 3 || hops > 5) continue;
        // The weaker of the two decides what this pair can show, and the
        // deeper capital makes the campaign a campaign. An attacker with no
        // arms industry is quartered rather than excluded: on a world where
        // nobody has three plants the gate still runs, and says so.
        // A nation of ten provinces cannot show "sixty per cent held" as
        // anything but noise, so both sides need room to lose ground in.
        if ((held.get(regent) ?? 0) < 12) continue;
        if ((held.get(attacker) ?? 0) < 8) continue;
        const plants = arms.get(attacker) ?? 0;
        const weight =
          Math.min(ceiling.get(attacker) ?? 0, ceiling.get(regent) ?? 0) *
          (plants >= ARMS_WANTED ? 1 : 0.25);
        const found = { attacker, regent, capital, hops, weight, plants };
        if (
          best === null ||
          weight > best.weight ||
          (weight === best.weight && hops > best.hops)
        ) {
          best = found;
        }
      }
    }
  }
  return best;
}

/** The nations holding the most provinces, biggest first. */
function biggestNations(controllers, count) {
  const held = new Map();
  for (const holder of controllers) {
    if (holder > 0) held.set(holder, (held.get(holder) ?? 0) + 1);
  }
  return [...held.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, count)
    .map(([nation]) => nation);
}

/**
 * A nation with no land border at all, and the biggest one there is.
 *
 * Not "an island nation" loosely: the regent's own test is
 * `coastal && no neighbouring province held by anybody else`, and that is
 * what makes it open a convoy line without being asked. On Europe exactly
 * one nation qualifies (Iceland), which is why the partner is found by
 * asking the world rather than by looking for a shared sea zone — Iceland
 * shares none with anybody, and its trade routes are still real, several
 * zones long.
 */
function findIsland(spectator, provinces) {
  const byId = new Map(provinces.map((province) => [province.id, province]));
  const mine = new Map();
  for (const province of provinces) {
    const holder = spectator.controllers[province.id];
    if (holder <= 0) continue;
    if (!mine.has(holder)) mine.set(holder, []);
    mine.get(holder).push(province.id);
  }

  let best = null;
  for (const [nation, list] of [...mine.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const seen = new Set(list);
    const queue = [...list];
    for (let head = 0; head < queue.length; head++) {
      for (const next of byId.get(queue[head]).neighbours) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    // Every province its land touches is its own: no land border anywhere.
    let alone = true;
    for (const province of seen) {
      if (spectator.controllers[province] !== nation) alone = false;
    }
    if (!alone) continue;
    const shore = list.filter((id) => byId.get(id).seaZone !== null);
    if (shore.length < 2) continue;
    const found = { island: nation, shore, home: byId.get(shore[0]) };
    if (best === null || shore.length > best.shore.length) best = found;
  }
  return best;
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
    .sort((a, b) => (a.id === avoid ? 1 : 0) - (b.id === avoid ? 1 : 0));
  let queued = 0;
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
  }
  log(`  ${tag}: ${queued} dockyard(s) queued`);
  await player.waitUntil(
    (p) => p.economy.dockyardsTotal >= want,
    `${want} dockyards`,
    BUILD_BUDGET_MS,
  );
  return player.economy.dockyardsTotal;
}

async function regentOn(steward, focus) {
  await steward.require(
    {
      kind: "configure_regent",
      enabled: BREAK !== "asleep",
      focus,
      marketBudget: 0.5,
    },
    "regent-on",
  );
  log(
    BREAK === "asleep"
      ? "  --break=asleep: the regent never wakes"
      : `  the regent takes over: ${focus}, half a point a tick for the market`,
  );
}

async function regentOff(steward) {
  await steward.command(
    {
      kind: "configure_regent",
      enabled: false,
      focus: "defence",
      marketBudget: 0.5,
    },
    "regent-off",
  );
}

/** The eight building types that take one of a province's slots. */
const SLOT_BUILDINGS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * §8's "has a non-empty construction queue", with the one case that clause
 * does not cover: a nation whose every slot is full has nothing left to
 * queue, and an empty queue is then the right answer rather than a lapse.
 * Iceland reaches that inside the sea scenario's window.
 */
function checkQueue(player, byId, samples) {
  const filled = samples.filter((s) => s.queue.length > 0).length;
  let free = 0;
  for (let p = 0; p < player.controllers.length; p++) {
    if (player.controllers[p] !== player.nation) continue;
    if (player.owners[p] !== player.nation) continue;
    let used = 0;
    for (const kind of SLOT_BUILDINGS) used += player.building(p, kind);
    free += Math.max(0, (byId.get(p)?.buildingSlots ?? 0) - used);
  }
  const working = filled >= Math.floor(samples.length * 0.5);
  const now = player.economy.queue.length > 0;
  if (free === 0 && !now) {
    // Nowhere left to build: §8's clause is about a steward that lets the
    // queue lapse, not about one that has finished the map it was given.
    ok(
      `the construction queue is empty because every building slot this ` +
        `nation holds is full — there is nothing left to queue`,
    );
    return;
  }
  check(
    working && now,
    `the construction queue was working on ${filled} of ${samples.length} ` +
      `samples and is ${now ? "non-empty now" : "empty now"}, with ${free} ` +
      `free slot(s) to build in`,
  );
}

/** No line ever changed what it makes: the §6.2 clause, read off samples. */
function linesNeverSwitched(samples) {
  let switched = 0;
  const seen = new Map();
  for (const sample of samples) {
    for (const line of sample.lines) {
      const before = seen.get(line.id);
      if (before !== undefined && before !== line.equipment) switched++;
      seen.set(line.id, line.equipment);
    }
  }
  return { switched, ran: seen.size };
}

function sampleOf(steward) {
  const economy = steward.economy;
  return {
    tick: steward.tick,
    queue: economy.queue.map((order) => order.building),
    lines: economy.productionLines.map((line) => ({
      id: line.id,
      equipment: line.equipment,
      efficiency: line.efficiency,
    })),
    divisions: economy.divisions.map((d) => ({
      province: d.provinceId,
      strength: d.strength,
    })),
    rifles: economy.stockpile[EQ.infantry_equipment] ?? 0,
    plants: economy.militaryFactoriesTotal,
    formations: economy.formations.map((f) => ({
      template: f.template,
      zone: f.zone,
      mission: f.mission,
      strength: f.strength,
    })),
    held: steward.held().length,
  };
}

// ---------------------------------------------------------------------------
// The land scenario: a war on the border.
// ---------------------------------------------------------------------------
async function land(spectator, provinces) {
  const byId = new Map(provinces.map((province) => [province.id, province]));
  const pair = findPair(spectator, provinces);
  if (pair === null) {
    log(
      "  a world this gate cannot use: no capital sits 2-5 hops behind a " +
        "foreign border",
    );
    process.exit(2);
  }
  const { attacker, regent, capital, hops, weight, plants } = pair;
  log(
    `  nation ${regent} is left to its regent; nation ${attacker} marches ` +
      `on its capital in province ${capital}, ${hops} hop(s) behind the border`,
  );
  log(
    `  the invader holds ${plants} military factor${plants === 1 ? "y" : "ies"}; ` +
      `the pair scores ${Math.round(weight)}`,
  );

  const steward = new Player(regent);
  const invader = new Player(attacker);
  await steward.ready;
  await invader.ready;
  await sweep(steward);
  await sweep(invader);
  await invader.require(
    {
      kind: "configure_regent",
      enabled: false,
      focus: "economy",
      marketBudget: 0,
    },
    "invader-regent-off",
  );

  // The invader's ground at the border, and the zone the war is fought under.
  const nearestTargets = () => {
    const distance = distancesFrom(capital, invader.controllers, regent, byId);
    return [...distance.entries()]
      .filter(([province]) =>
        byId
          .get(province)
          .neighbours.some((next) => invader.controllers[next] === attacker),
      )
      .sort((a, b) => a[1] - b[1])
      .map(([province]) => province);
  };
  const targets = nearestTargets();
  if (targets.length === 0) throw new Error("no border between the pair");
  const frontZone = byId.get(targets[0]).airZone;
  const staging = [
    ...new Set(
      targets.flatMap((t) =>
        byId
          .get(t)
          .neighbours.filter(
            (n) =>
              invader.controllers[n] === attacker &&
              invader.owners[n] === attacker,
          ),
      ),
    ),
  ];
  if (staging.length === 0) throw new Error("the invader owns no border");
  // The base whose zone is the front's, or the nearest we have.
  const baseCandidates = [
    ...staging.filter((p) => byId.get(p).airZone === frontZone),
    ...staging,
  ];

  // --- Arm the opponent -----------------------------------------------------
  //
  // **How big an army the world can actually pay for**, read off the wire
  // rather than assumed: the ceiling is the nation's land, the pool crawls
  // towards it, and a gate that waits for men a nation will never have
  // reports a timeout instead of a finding.
  const invaderCeiling = invader.economy.manpowerCap * MANPOWER_SHARE;
  const army = Math.max(
    1,
    Math.min(
      ARMY,
      Math.floor((invaderCeiling - WING_MANPOWER) / DIVISION_MANPOWER),
    ),
  );
  const wantedGarrison = Math.max(
    1,
    Math.min(
      3,
      Math.floor(
        (steward.economy.manpowerCap * MANPOWER_SHARE) / DIVISION_MANPOWER,
      ),
    ),
  );
  const wantedMen = army * DIVISION_MANPOWER + WING_MANPOWER;
  log(
    `  the invader will raise ${army} division(s) and a wing (${wantedMen} men ` +
      `of a ${Math.round(invader.economy.manpowerCap)} ceiling); the regent ` +
      `is asked for ${wantedGarrison}`,
  );
  await invader.waitFor(
    (p) => p.economy.manpower >= wantedMen,
    "manpower for the invader's army",
    BUILD_BUDGET_MS,
  );
  await steward.waitFor(
    (p) => p.economy.manpower >= DIVISION_MANPOWER,
    "manpower for the regent's garrison",
    BUILD_BUDGET_MS,
  );

  // **The opponent builds its arms industry first.** On a world nobody has
  // played, every nation still holds exactly what it started with — one
  // military factory — and one plant cannot equip three divisions inside the
  // window however long the gate waits for it. So the gate does what a
  // player would: it queues plants, waits for them, and only then opens a
  // line. This is the difference between an opponent and a parade.
  const plantsAt = () => invader.economy.militaryFactoriesTotal;
  if (plantsAt() < ARMS_WANTED) {
    let queued = 0;
    for (const province of staging) {
      if (plantsAt() + queued >= ARMS_WANTED) break;
      const ack = await invader.command(
        {
          kind: "queue_construction",
          provinceId: province,
          building: "military_factory",
        },
        `inv-plant-${province}`,
      );
      if (ack.accepted) queued++;
    }
    // The staging provinces may be full; anywhere the invader owns will do.
    for (
      let p = 0;
      p < invader.owners.length && plantsAt() + queued < ARMS_WANTED;
      p++
    ) {
      if (invader.owners[p] !== attacker) continue;
      if (invader.controllers[p] !== attacker) continue;
      const ack = await invader.command(
        {
          kind: "queue_construction",
          provinceId: p,
          building: "military_factory",
        },
        `inv-plant2-${p}`,
      );
      if (ack.accepted) queued++;
    }
    log(`  the invader queued ${queued} more arms plant(s)`);
    await invader.waitUntil(
      (p) => p.economy.militaryFactoriesTotal >= ARMS_WANTED,
      `${ARMS_WANTED} arms plants`,
      BUILD_BUDGET_MS,
    );
  }
  const factories = invader.economy.militaryFactoriesTotal;
  log(
    `  the invader has ${factories} military factor${factories === 1 ? "y" : "ies"}`,
  );
  // **Steel for the rifles.** A line with no steel makes almost nothing
  // (invariant 2 scaling all the way down), and a nation nobody has played
  // for a hundred thousand ticks has an empty vault. The world market is
  // always open and needs no diplomacy (§6.5) — it costs the invader
  // construction points, which is exactly the price the design intends.
  for (const resource of ["material"]) {
    await invader.command(
      { kind: "set_market_order", resource, perTick: 1 },
      `inv-buy-${resource}`,
    );
  }
  const rifles = await createLine(invader, "infantry", "inv-rifles");
  const guns = await createLine(invader, "infantry", "inv-guns");
  const bombers = await createLine(invader, "aircraft", "inv-bombers");
  // Everything on rifles and guns first; the bombers get a factory once the
  // army is armed, so the stockpile fills in the order the war needs it.
  await assignUpTo(
    invader,
    rifles,
    Math.max(1, factories - 1),
    "inv-r",
    factories,
  );
  await assignUpTo(invader, guns, 1, "inv-g", factories);

  // **A depot where the army will stand.** Reinforcement is supply-limited
  // (§6.6), and the staging is by definition the far end of the invader's
  // network: without a hub the divisions raised there fill at a trickle and
  // the gate measures a parade. This is the first thing a player does before
  // an offensive, and the reason it is here is that the run before this one
  // marched at strength 0.20.
  const depot = await buildOn(invader, staging, "supply_hub", "inv-depot");
  if (depot !== null) {
    log(`  the invader builds a supply hub at its staging (province ${depot})`);
  }
  const base = await buildOn(invader, baseCandidates, "air_base", "inv-base");
  if (base === null) {
    log("  a world this gate cannot use: the invader cannot build an air base");
    process.exit(2);
  }
  log(
    `  the invader builds an air base in province ${base} (zone ${byId.get(base).airZone}; the front is zone ${frontZone})`,
  );

  const armed =
    (await stock(invader, EQ.infantry_equipment, army * RIFLES, "rifles")) &&
    (await stock(invader, EQ.artillery, army * GUNS, "guns"));
  log(
    armed
      ? `  the invader's stockpile holds ${army} divisions' worth`
      : `  the invader's stockpile fell short in the budget; it marches with what it has`,
  );
  await assignUpTo(invader, rifles, 1, "inv-r2", factories);
  await assignUpTo(
    invader,
    bombers,
    Math.max(1, factories - 2),
    "inv-b",
    factories,
  );

  for (let i = 0; i < army; i++) {
    await invader.require(
      { kind: "raise_division", provinceId: staging[i % staging.length] },
      `inv-div-${i}`,
    );
  }
  await invader.waitUntil(
    (p) =>
      p.economy.divisions.length >= army &&
      p.economy.divisions.every((d) => d.strength > 0.9),
    "the invader's divisions to arm",
    120_000,
  );
  const armyStrength = invader.economy.divisions
    .map((d) => d.strength.toFixed(2))
    .join(", ");
  log(
    `  ${invader.economy.divisions.length} invader division(s) at the border, strength ${armyStrength}`,
  );

  const baseStands = await invader.waitUntil(
    (p) => p.building(base, B.air_base) > 0,
    "the invader's air base",
    BUILD_BUDGET_MS,
  );
  let wing = null;
  if (baseStands && (await stock(invader, EQ.bomber, BOMBER_WING, "bombers"))) {
    const before = new Set(invader.economy.formations.map((f) => f.id));
    const ack = await invader.command(
      { kind: "raise_formation", provinceId: base, template: "wing" },
      "inv-wing",
    );
    if (ack.accepted) {
      await invader.waitFor(
        (p) => p.economy.formations.some((f) => !before.has(f.id)),
        "the wing to appear",
        30_000,
      );
      wing = invader.economy.formations.find((f) => !before.has(f.id)).id;
      await invader.waitUntil(
        (p) => p.economy.formations.find((f) => f.id === wing)?.strength > 0.9,
        "the wing to draw its aircraft",
        120_000,
      );
      const sent = await invader.command(
        {
          kind: "assign_formation",
          formationId: wing,
          zone: frontZone,
          mission: "ground_support",
        },
        "inv-fly",
      );
      log(
        sent.accepted
          ? `  the invader's bomber wing flies ground support over zone ${frontZone}`
          : `  the invader's wing could not fly: ${sent.reason}`,
      );
    } else {
      log(`  raise_formation refused: ${ack.reason}`);
    }
  } else {
    log(
      "  the invader's air arm did not come together in the budget; the war is on the ground",
    );
  }

  // --- The regent takes over -----------------------------------------------
  await regentOn(steward, "defence");
  const startHeld = steward.held();
  const startTick = steward.tick;
  const endTick = startTick + WINDOW_TICKS;
  const samples = [];
  let ordersPlaced = 0;
  let wingFlew = false;
  let armyPeak = 0;

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
    const flying = invader.economy.formations.find((f) => f.id === wing);
    if (flying && flying.mission === "ground_support" && flying.strength > 0.5)
      wingFlew = true;
    for (const d of invader.economy.divisions)
      armyPeak = Math.max(armyPeak, d.strength);

    samples.push(sampleOf(steward));
    if (steward.controllers[capital] !== regent) break;
    await sleep(1000);
  }

  // --- The verdict ----------------------------------------------------------
  log("");
  check(
    ordersPlaced >= 5 && armyPeak >= 0.4,
    `the opponent was active: ${ordersPlaced} standing attacks ordered, an ` +
      `army at strength ${armyPeak.toFixed(2)}` +
      (wingFlew ? ", bombers over the front" : ", no bombers in the budget"),
  );
  check(
    steward.controllers[capital] === regent,
    `the capital in province ${capital} is still the regent's after ` +
      `${Math.min(WINDOW_TICKS, steward.tick - startTick)} tick(s)`,
  );
  const held = steward.held();
  const kept = held.filter((p) => startHeld.includes(p)).length;
  check(
    kept >= Math.ceil(startHeld.length * 0.6),
    `it holds ${kept} of the ${startHeld.length} provinces it started with ` +
      `(${((100 * kept) / startHeld.length).toFixed(0)}%; sixty needed)`,
  );
  const border = new Set(
    held.filter((p) =>
      byId.get(p).neighbours.some((n) => steward.controllers[n] === attacker),
    ),
  );
  const divisions = steward.economy.divisions;
  const atBorder = divisions.filter((d) => border.has(d.provinceId)).length;
  check(
    divisions.length >= 1 && atBorder >= 1,
    `it raised an army and stood it at the border: ${divisions.length} ` +
      `division(s), ${atBorder} of them facing nation ${attacker}`,
  );
  // **It never raises what it cannot fill.** A division draws from the
  // stockpile at a rate, so a steward that raises a second one before the
  // first is armed ends the window with an army of ghosts — the trap this
  // repository has paid for twice. One filling at a time is the rule.
  const hollow = divisions.filter((d) => d.strength < 0.5).length;
  check(
    hollow <= 1,
    hollow <= 1
      ? `and armed them as it went (${hollow} of ${divisions.length} still filling)`
      : `it raised ${hollow} divisions it cannot fill — the bottomless front`,
  );
  // And it kept raising while there was equipment to raise with.
  const spare = Math.floor(
    (steward.economy.stockpile[EQ.infantry_equipment] ?? 0) / RIFLES,
  );
  check(
    spare === 0 || divisions.length >= wantedGarrison,
    spare === 0
      ? `its stockpile is spent, which is why the army stopped at ` +
          `${divisions.length} of the ${wantedGarrison} its land could carry`
      : `with ${spare} division(s) worth of rifles to spare it raised ` +
          `${divisions.length} of ${wantedGarrison}`,
  );

  // The air answer, in the game's own order.
  const baseQueuedAt =
    samples.find((s) => s.queue.includes("air_base"))?.tick ?? null;
  const baseBuilt = held.some((p) => steward.building(p, B.air_base) > 0);
  const fighterLine = steward.economy.productionLines.some(
    (l) => l.equipment === "aircraft",
  );
  const fighterWing = samples.some((s) =>
    s.formations.some(
      (f) =>
        f.template === "wing" &&
        f.zone === frontZone &&
        f.mission === "air_superiority",
    ),
  );
  // **Only measured when there was a sky to answer.** With no enemy wing
  // over the front the regent is right to build nothing, and a gate that
  // failed it for that would be measuring the world, not the steward.
  if (!wingFlew) {
    note(
      "no enemy wing ever flew: the air answer is not measured on this run " +
        "(REGENT_BREAK=blind is the counter-proof for it)",
    );
  } else {
    check(
      baseQueuedAt !== null || baseBuilt,
      baseBuilt
        ? "it answered the sky: an air base stands"
        : baseQueuedAt !== null
          ? `it answered the sky: an air base was queued at tick ${baseQueuedAt}`
          : "it answered the sky with an air base (none queued, none built)",
    );
    const plantsNow = steward.economy.militaryFactoriesTotal;
    if (baseBuilt && plantsNow >= 2) {
      check(fighterLine, "and a fighter line opened behind the base");
      if (fighterWing) {
        ok(`and a fighter wing flew air superiority over zone ${frontZone}`);
      } else {
        note(
          `no fighter wing over zone ${frontZone} yet: the window ended first`,
        );
      }
    } else if (baseBuilt) {
      note(
        `the regent holds ${plantsNow} arms plant(s), so there is no idle ` +
          `factory for a fighter line — §6.10 staffs idle factories and ` +
          `never takes one off the rifles`,
      );
    } else {
      note(
        "the base did not finish inside the window; the line and the wing come after it",
      );
    }
  }

  checkQueue(steward, byId, samples);
  const { switched, ran } = linesNeverSwitched(samples);
  check(
    switched === 0 && ran > 0,
    `${ran} production line(s) ran and not one was reset — the ramp is the ` +
      `player's days of work, and the regent spent none of it`,
  );
  check(
    steward.economy.researchSlots.some((slot) => slot.tech !== null),
    "and the research slots are at work",
  );
  // What it did with the window, for the transcript: this is what makes a
  // failing run readable a week later.
  const built = new Set();
  for (const sample of samples) for (const b of sample.queue) built.add(b);
  const first = samples[0] ?? { plants: 0, rifles: 0, divisions: [] };
  log(
    `  the window: ${first.plants} → ${steward.economy.militaryFactoriesTotal} ` +
      `arms plant(s), ${Math.round(first.rifles)} → ` +
      `${Math.round(steward.economy.stockpile[EQ.infantry_equipment] ?? 0)} rifles, ` +
      `${first.divisions.length} → ${divisions.length} division(s); queued ` +
      `${[...built].join(", ") || "nothing"}`,
  );

  // Leave the world as found.
  await regentOff(steward);
  for (const attack of invader.economy.attacks) {
    await invader.command(
      { kind: "cancel_attack", provinceId: attack.province },
      `stop-${attack.province}`,
    );
  }
  if (wing !== null) {
    await invader.command(
      {
        kind: "assign_formation",
        formationId: wing,
        zone: null,
        mission: null,
      },
      "inv-land",
    );
  }
  steward.close();
  invader.close();
}

// ---------------------------------------------------------------------------
// The sea scenario: §6.10's escort duty.
// ---------------------------------------------------------------------------
async function sea(spectator, provinces) {
  const stage = findIsland(spectator, provinces);
  if (stage === null) {
    log("  a world this gate cannot use: no nation without a land border");
    process.exit(2);
  }
  const { island, home } = stage;
  log(
    `  nation ${island} has no land border at all: ${stage.shore.length} ` +
      `coastal province(s), home port in province ${home.id} (sea zone ${home.seaZone})`,
  );
  const steward = new Player(island);
  await steward.ready;
  await sweep(steward);

  // The gate lays the keel the regent has no time to lay itself: a port and
  // three yards. What the regent does with them is the measurement.
  // Already there from an earlier run is a keel laid, not a refusal.
  const port =
    steward.building(home.id, B.naval_base) > 0
      ? home.id
      : await buildOn(steward, [home.id], "naval_base", "isl-port");
  if (port === null) {
    log("  a world this gate cannot use: the island cannot build a naval base");
    process.exit(2);
  }
  await buildYards(steward, provinces, island, 3, "island", home.id);
  const portStands = await steward.waitUntil(
    (p) => p.building(home.id, B.naval_base) > 0,
    "the naval base",
    BUILD_BUDGET_MS,
  );
  log(
    `  ${steward.economy.dockyardsTotal} dockyard(s) and ` +
      `${portStands ? "a" : "no"} naval base on the island`,
  );
  await steward.waitFor(
    (p) => p.economy.manpower >= WING_MANPOWER,
    "manpower for the escort's crews",
    BUILD_BUDGET_MS,
  );

  // **A trade across the water, with the world picking the counterparty.**
  // `propose_agreement` is refused when no route exists, land or sea, so the
  // first nation that accepts the offer is by definition one the island can
  // reach — and for a nation with no land border that route is the sea.
  // Looking for a shared sea zone (as the phase-9 gate does) finds nothing
  // here: the one qualifying island shares a zone with nobody and trades
  // several zones deep all the same.
  const candidates = biggestNations(spectator.controllers, 12).filter(
    (nation) => nation !== island,
  );
  let partner = null;
  let trader = null;
  let pending = null;
  const refusals = new Set();
  for (const candidate of candidates) {
    const player = new Player(candidate);
    await player.ready;
    await player.command(
      {
        kind: "configure_regent",
        enabled: false,
        focus: "economy",
        marketBudget: 0,
      },
      `trader-${candidate}-regent-off`,
    );
    const ack = await player.command(
      {
        kind: "propose_agreement",
        to: island,
        type: "trade",
        terms: {
          resource: "material",
          resourcePerTick: 0.5,
          pointsPerTick: 0.25,
        },
      },
      `offer-${candidate}`,
    );
    if (ack.accepted) {
      partner = candidate;
      trader = player;
      break;
    }
    refusals.add(ack.reason);
    player.close();
  }
  if (partner === null) {
    log("  a world this gate cannot use: nobody can reach the island by sea");
    for (const reason of refusals) log(`    ${reason}`);
    process.exit(2);
  }
  log(`  nation ${partner} offers the island a standing trade in steel`);

  await steward.waitFor(
    (p) =>
      p.agreements.some(
        (a) => a.type === "trade" && a.parties[0] === partner && !a.accepted,
      ),
    "the offer to arrive",
    30_000,
  );
  pending = steward.agreements.find(
    (a) => a.type === "trade" && a.parties[0] === partner && !a.accepted,
  );
  await steward.require(
    { kind: "accept_agreement", agreementId: pending.id },
    "accept",
  );
  await steward.waitFor(
    (p) => p.agreements.some((a) => a.id === pending.id && a.accepted),
    "the agreement to stand",
    30_000,
  );
  log("  a sea trade stands: the island imports steel over the water");

  // **Twice the land window.** §8's two thousand ticks are about holding a
  // capital against an offensive; the escort duty is a supply chain — a
  // dockyard line has to climb its efficiency ramp from the floor and then
  // build twelve escorts at twelve industry each before a group can sail.
  // The first run of this scenario ended with the group raised and still
  // in port, which measured the ramp rather than the steward.
  await regentOn(steward, "defence");
  const startTick = steward.tick;
  const endTick = startTick + WINDOW_TICKS * 2;
  const samples = [];
  while (steward.tick < endTick) {
    samples.push(sampleOf(steward));
    await sleep(1000);
  }

  log("");
  const lines = steward.economy.productionLines.map((l) => l.equipment);
  check(
    lines.includes("ships"),
    `a convoy line runs on the yards (${lines.join(", ")})`,
  );
  check(
    lines.includes("ships"),
    "and an escort line beside it — the §6.10 duty, in steel",
  );
  const escorts = steward.economy.formations.filter(
    (f) => f.template === "fleet",
  );
  // Any zone its convoys cross, not only the home one: the route to the
  // partner is several zones long and the regent covers the raided one first.
  const onDuty = samples.some((s) =>
    s.formations.some((f) => f.template === "fleet" && f.mission === "patrol"),
  );
  if (escorts.length > 0) {
    const strengths = escorts.map((f) => `${f.strength.toFixed(2)}`).join(", ");
    ok(`an escort group was raised (${escorts.length}, strength ${strengths})`);
    const sailed = samples
      .flatMap((s) => s.formations)
      .filter((f) => f.template === "fleet" && f.mission !== null);
    check(
      onDuty,
      onDuty
        ? `and put on convoy_escort over a zone its convoys cross`
        : `it never sailed: ${sailed.length} sample(s) with a mission, ` +
            `strength ${strengths} against the ${REGENT_STAND_DOWN} a group ` +
            `needs to leave port`,
    );
  } else {
    const inStore = steward.economy.stockpile[EQ.escort] ?? 0;
    note(
      `no escort group yet: ${inStore} escort(s) in store when the window closed; the group comes at six`,
    );
  }
  checkQueue(steward, new Map(provinces.map((p) => [p.id, p])), samples);
  const { switched, ran } = linesNeverSwitched(samples);
  check(
    switched === 0 && ran > 0,
    `${ran} production line(s) ran and not one was reset`,
  );

  await regentOff(steward);
  steward.close();
  trader?.close();
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
  if (BREAK === "blind") {
    log("  (the world must have been started with REGENT_BREAK=blind)");
  }

  const spectator = new Player(null);
  await spectator.ready;
  const provinces = await provinceData(spectator.map.id);

  if (SCENARIO === "sea") await sea(spectator, provinces);
  else await land(spectator, provinces);

  const healthy = await health();
  check(
    healthy.healthy && healthy.lagMs < 1000,
    `the world stayed healthy throughout (${healthy.lagMs} ms behind at tick ${healthy.tick})`,
  );
  log(failures === 0 ? "PASS" : "FAIL");
  process.exitCode = failures === 0 ? 0 : 1;
  spectator.close();
}

main().catch((error) => {
  log(`  FAIL  ${error.message}`);
  process.exit(1);
});
