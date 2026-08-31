#!/usr/bin/env node
/**
 * The phase-2 gate: a province changes hands, ownership propagates from
 * tiles, and the client's picture of it is complete.
 *
 * CLAUDE.md §8 words the gate as "a province changes hands, ownership
 * propagates from tiles, and the client renders it correctly". This checks
 * everything up to the last clause. Rendering is the one thing this project
 * has no automated leg for — the browser has to be looked at by hand
 * (HANDOVER.md) — so the gate proves the data the renderer is handed, and the
 * morning checklist covers the pixels.
 *
 * Four things, in order of how badly they would hurt:
 *
 * 1. **The world runs the artefact that is on disk.** Province ids are static
 *    map data that never travels; if the world and the checkout disagree, the
 *    ids mean different places and nothing on the wire notices.
 * 2. **A claim moves the controller and not the owner.** Decision 0002 splits
 *    the two, and the split is only real if it can be seen from outside.
 * 3. **The deltas are complete.** A second connection asks for a fresh full
 *    state; the first has been reconstructing the same world from deltas
 *    alone since it connected. They have to be identical.
 * 4. **The tile projection is total.** Every land tile resolves to exactly one
 *    province and carries that province's controller; no water tile carries
 *    anything. That is "ownership propagates from tiles" in the form decision
 *    0002 leaves it in — the province is the state, tiles are projected from
 *    it, and the projection covers the map.
 *
 * Run it against `docker compose up -d`:
 *
 *   node scripts/phase2-gate.mjs
 *
 * And prove it can fail, which is the only way to know it is a gate:
 *
 *   node scripts/phase2-gate.mjs --break=artefact   # lie about the partition
 *   node scripts/phase2-gate.mjs --break=deltas     # drop one delta in three
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const WS_URL = process.env.WORLD_WS ?? "ws://localhost:3000/ws";
const HEALTH_URL = process.env.WORLD_HEALTH ?? "http://localhost:3000/health";
const WORLD_ID = process.env.WORLD_ID ?? "world-0";
const MAP_ID = process.env.MAP_ID ?? "europe";

/**
 * Must equal PROTOCOL_VERSION in src/shared/protocol/Wire.ts.
 *
 * This file is .mjs and cannot import it. `tests/GateProtocolVersion.test.ts`
 * reads this line and compares it, because a gate that stops at "the world
 * refused the connection" is the gate failing rather than the world.
 */
const PROTOCOL_VERSION = 9;

/** How long to wait for a message that should arrive within a tick or two. */
const MESSAGE_TIMEOUT_MS = 30_000;

const BREAK = (() => {
  const arg = process.argv.find((a) => a.startsWith("--break="));
  return arg === undefined ? null : arg.slice("--break=".length);
})();

const log = (...parts) => console.log(...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The artefact, parsed here rather than imported
// ---------------------------------------------------------------------------

const HEADER_BYTES = 32;
const WATER_FLAG = 0x8000;

/**
 * Read provinces.bin and provinces.json without the project's own decoder.
 *
 * On purpose: a gate that calls the same function the server calls proves the
 * function agrees with itself. Twenty lines of independent parsing is what
 * makes the artefact check mean anything.
 */
async function readArtefact(mapId) {
  const dir = path.join(REPO, "resources", "maps", mapId);
  const [bin, metaText] = await Promise.all([
    fs.readFile(path.join(dir, "provinces.bin")),
    fs.readFile(path.join(dir, "provinces.json"), "utf-8"),
  ]);
  const meta = JSON.parse(metaText);

  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const header = {
    magic: view.getUint32(0, true),
    format: view.getUint32(4, true),
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    provinceCount: view.getUint32(16, true),
    terrainHash: view.getUint32(20, true),
  };
  if (header.magic !== 0x4d565250) {
    throw new Error("provinces.bin does not start with PRVM");
  }

  const tiles = header.width * header.height;
  const provinceOfTile = new Int32Array(tiles);
  for (let i = 0; i < tiles; i++) {
    const cell = view.getUint16(HEADER_BYTES + i * 2, true);
    provinceOfTile[i] = (cell & WATER_FLAG) === 0 ? cell : -1;
  }

  // FNV-1a over the whole file, the same way partitionHashFnv1a does it.
  let hash = 0x811c9dc5;
  for (let i = 0; i < bin.length; i++) {
    hash ^= bin[i];
    hash =
      (hash +
        ((hash << 1) +
          (hash << 4) +
          (hash << 7) +
          (hash << 8) +
          (hash << 24))) >>>
      0;
  }

  return {
    ...header,
    partitionHash: BREAK === "artefact" ? (hash ^ 0xff) >>> 0 : hash >>> 0,
    meta,
    provinceOfTile,
  };
}

/** Province -> tiles, so a claim's footprint can be named exactly. */
function tileIndex(provinceOfTile, provinceCount) {
  const counts = new Int32Array(provinceCount);
  let land = 0;
  for (let i = 0; i < provinceOfTile.length; i++) {
    if (provinceOfTile[i] < 0) continue;
    counts[provinceOfTile[i]]++;
    land++;
  }
  const offsets = new Int32Array(provinceCount + 1);
  for (let p = 0; p < provinceCount; p++)
    offsets[p + 1] = offsets[p] + counts[p];
  const tiles = new Int32Array(land);
  const cursor = Int32Array.from(offsets.subarray(0, provinceCount));
  for (let i = 0; i < provinceOfTile.length; i++) {
    const p = provinceOfTile[i];
    if (p >= 0) tiles[cursor[p]++] = i;
  }
  return { offsets, tiles, landCount: land };
}

/** What the renderer would be handed: one nation per tile, 0 for water. */
function project(provinceOfTile, controllers) {
  const tileState = new Uint16Array(provinceOfTile.length);
  for (let i = 0; i < provinceOfTile.length; i++) {
    const province = provinceOfTile[i];
    if (province >= 0) tileState[i] = controllers[province];
  }
  return tileState;
}

// ---------------------------------------------------------------------------
// A client, exactly as the real one behaves
// ---------------------------------------------------------------------------

class Watcher {
  constructor(nation = null) {
    this.nation = nation;
    this.owners = null;
    this.controllers = null;
    this.tick = null;
    this.deltas = 0;
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
        this.owners = message.owners;
        this.controllers = message.controllers;
        this.tick = message.tick;
        this.onReady();
        break;
      case "delta":
        this.deltas++;
        // The counter-proof: a client that misses a delta reconstructs a
        // world that is *nearly* right, which is exactly the failure the
        // comparison below has to be able to see.
        if (BREAK === "deltas" && this.deltas % 3 === 0) {
          this.tick = message.tick;
          break;
        }
        for (const [province, nation] of message.control) {
          this.controllers[province] = nation;
        }
        for (const [province, nation] of message.owner) {
          this.owners[province] = nation;
        }
        this.tick = message.tick;
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

  claim(province, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ack for ${id}`)),
        MESSAGE_TIMEOUT_MS,
      );
      this.acks.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      this.socket.send(
        JSON.stringify({
          t: "command",
          id,
          command: { kind: "claim_province", provinceId: province },
        }),
      );
    });
  }

  async waitForTick(tick) {
    const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
    while (this.tick < tick) {
      if (Date.now() > deadline) {
        throw new Error(`stuck at tick ${this.tick}, waiting for ${tick}`);
      }
      await sleep(200);
    }
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
  return { nation: best, provinces: bestCount };
}

/** A province this nation can take. Asking the world beats reimplementing it. */
async function claimSomething(watcher, idPrefix) {
  let attempt = 0;
  let refused = 0;
  for (let province = 0; province < watcher.controllers.length; province++) {
    const holder = watcher.controllers[province];
    if (holder === watcher.nation || holder === 0) continue;
    const ack = await watcher.claim(province, `${idPrefix}-${attempt++}`);
    if (ack.accepted) return { province, tick: ack.tick, refused };
    refused++;
  }
  throw new Error(
    `nation ${watcher.nation} could not claim anything (${refused} refused)`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  let failures = 0;
  const check = (ok, message) => {
    log(`${ok ? "  ok  " : "  FAIL"}  ${message}`);
    if (!ok) failures++;
  };

  log("phase-2 gate");
  if (BREAK !== null) log(`  running with --break=${BREAK}: this must FAIL`);

  const artefact = await readArtefact(MAP_ID);
  log(
    `  artefact on disk: ${artefact.provinceCount} provinces, ` +
      `partition ${artefact.partitionHash.toString(16)}, ` +
      `terrain ${artefact.terrainHash.toString(16)}`,
  );

  const health = await fetch(HEALTH_URL).then((r) => r.json());
  log(`  world ${health.worldId} at tick ${health.tick}`);

  const spectator = new Watcher(null);
  await spectator.ready;

  // 1. The world and the checkout are the same map.
  check(
    spectator.map.partitionHash === artefact.partitionHash,
    `the world runs the artefact on disk: ` +
      `${spectator.map.partitionHash.toString(16)} === ` +
      `${artefact.partitionHash.toString(16)}`,
  );
  check(
    spectator.map.terrainHash === artefact.terrainHash,
    `and the terrain it was generated from`,
  );
  check(
    spectator.map.provinceCount === artefact.provinceCount &&
      spectator.controllers.length === artefact.provinceCount,
    `${artefact.provinceCount} provinces, on the wire and on disk`,
  );

  // 4. The projection is total: every land tile, exactly once, and no water.
  const index = tileIndex(artefact.provinceOfTile, artefact.provinceCount);
  const projected = project(artefact.provinceOfTile, spectator.controllers);
  let uncovered = 0;
  let waterPainted = 0;
  let wrongNation = 0;
  for (let tile = 0; tile < artefact.provinceOfTile.length; tile++) {
    const province = artefact.provinceOfTile[tile];
    if (province < 0) {
      if (projected[tile] !== 0) waterPainted++;
      continue;
    }
    if (projected[tile] !== spectator.controllers[province]) uncovered++;
    if (projected[tile] > spectator.nations.length) wrongNation++;
  }
  check(
    uncovered === 0,
    `every one of ${index.landCount} land tiles carries its province's controller`,
  );
  check(waterPainted === 0, "no water tile carries a nation");
  check(wrongNation === 0, "no tile names a nation this world does not have");

  // 2. A claim moves control, and only control.
  const largest = largestNation(spectator.controllers);
  log(
    `  nation ${largest.nation} holds the most provinces (${largest.provinces})`,
  );
  const player = new Watcher(largest.nation);
  await player.ready;

  const claimed = await claimSomething(player, "gate2");
  log(
    `  claimed province ${claimed.province} for tick ${claimed.tick} ` +
      `(${claimed.refused} refused on the way)`,
  );
  const ownerBefore = player.owners[claimed.province];
  await player.waitForTick(claimed.tick);

  check(
    player.controllers[claimed.province] === largest.nation,
    `the claim moved the controller of province ${claimed.province}`,
  );
  check(
    player.owners[claimed.province] === ownerBefore,
    `and left its owner alone — holding is not owning (decision 0002)`,
  );

  // And the tiles the claim moved are exactly that province's tiles.
  const after = project(artefact.provinceOfTile, player.controllers);
  const provinceTiles = index.tiles.subarray(
    index.offsets[claimed.province],
    index.offsets[claimed.province + 1],
  );
  let repainted = 0;
  for (const tile of provinceTiles) {
    if (after[tile] === largest.nation) repainted++;
  }
  check(
    repainted === provinceTiles.length,
    `all ${provinceTiles.length} tiles of province ${claimed.province} now read ` +
      `nation ${largest.nation}`,
  );

  // 3. The deltas are complete: a fresh connection sees the same world.
  log("  letting the world run, then asking for a fresh full state...");
  await player.waitForTick(player.tick + 3);
  const fresh = new Watcher(null);
  await fresh.ready;
  await player.waitForTick(fresh.tick);

  const sameControl =
    player.controllers.length === fresh.controllers.length &&
    player.controllers.every((n, i) => n === fresh.controllers[i]);
  const sameOwner =
    player.owners.length === fresh.owners.length &&
    player.owners.every((n, i) => n === fresh.owners[i]);
  check(
    sameControl,
    `a world rebuilt from ${player.deltas} deltas matches a fresh full state ` +
      `at tick ${fresh.tick}`,
  );
  check(sameOwner, "and agrees about ownership too");

  spectator.close();
  player.close();
  fresh.close();

  log(failures === 0 ? "PASS" : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
