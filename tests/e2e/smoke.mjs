/**
 * The browser leg: open the real client against a running world and check
 * that a person would see a game.
 *
 * Everything else in this project is proved by a script that never opens a
 * page, and on 2026-08-31 that gap hid three client bugs at once — a HUD
 * painted under the map among them. This is the smallest check that would
 * have caught them: the map canvas exists at window size, the menu bar has
 * its six buttons, the clock shows a day, the economy panel carries numbers,
 * a click on the map opens a province panel, and nothing threw.
 *
 * It wants a world on :3000 and the Vite dev server on :9000, and refuses
 * with instructions rather than failing when either is missing — the same
 * manner as the gate scripts.
 *
 *   docker compose up -d && npm run start:client &
 *   npm run test:e2e -- --nation=17 --screenshot=/tmp/world.png
 *
 * **Software WebGL, deliberately.** `initGL.ts` refuses a SwiftShader
 * context, and for a player that is right (the game runs at 1 fps on it).
 * Headless Chromium has nothing else, so the page is given an init script
 * that hides the renderer string and drops `failIfMajorPerformanceCaveat` —
 * test-side, never in the client. The frames are slow; the DOM is not what
 * is slow, and the DOM is what this checks.
 *
 * Playwright's own Chromium *can* open the page's WebSocket. The note in
 * HANDOVER about automated Chrome failing at `/ws` was about a browser
 * extension's sandbox, not about headless browsers — this script is the
 * evidence, on 2026-09-01.
 */

import { chromium } from "playwright";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const nation = Number(args.get("nation") ?? "17");
const client = args.get("client") ?? "http://localhost:9000";
const health = args.get("health") ?? "http://localhost:3000/health";
const screenshot = args.get("screenshot");
const timeoutMs = Number(args.get("timeout") ?? "60000");

let failed = 0;
function ok(condition, text) {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${text}`);
  if (!condition) failed++;
  return condition;
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

console.log("browser smoke");
const healthBody = await reachable(health);
if (healthBody === null) {
  console.log(`  no world at ${health} — start one:\n    docker compose up -d`);
  process.exit(2);
}
const world = JSON.parse(healthBody);
console.log(
  `  world ${world.worldId} at tick ${world.tick}, ${world.provinces} provinces`,
);
if ((await reachable(client)) === null) {
  console.log(
    `  no client at ${client} — start one:\n    npm run start:client`,
  );
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  // These two, not `--use-angle=swiftshader`: with ANGLE the accelerated
  // context request comes back null and initGL reports "software" before the
  // init script below can help.
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  // The HUD picks its language from the browser; the checks below read
  // English.
  locale: "en-US",
});

const errors = [];
const frames = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("websocket", (socket) => {
  if (!socket.url().endsWith("/ws")) return;
  socket.on("framereceived", (frame) => {
    const text = String(frame.payload);
    try {
      frames.push(JSON.parse(text).t);
    } catch {
      frames.push("?");
    }
  });
});

await page.addInitScript(() => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (attrs !== undefined && attrs !== null && typeof attrs === "object") {
      attrs = { ...attrs };
      delete attrs.failIfMajorPerformanceCaveat;
    }
    return getContext.call(this, type, attrs);
  };
  const getParameter = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (name) {
    const debug = this.getExtension("WEBGL_debug_renderer_info");
    if (debug !== null && name === debug.UNMASKED_RENDERER_WEBGL) {
      // Must not match initGL's /swiftshader|llvmpipe|software/i — the first
      // version of this line said "software" and gated itself.
      return "headless smoke GPU (spoofed by tests/e2e/smoke.mjs)";
    }
    return getParameter.call(this, name);
  };
});

const started = Date.now();
await page.goto(`${client}/?nation=${nation}`, { waitUntil: "load" });

try {
  await page.waitForSelector("#world-menu", { timeout: timeoutMs });
} catch {
  // fall through: every check below then fails with its own line
}
const buttons = await page.$$eval("#world-menu button", (list) => list.length);
ok(buttons === 6, `the menu bar has six buttons (${buttons})`);

// The canvas is created at its default 300x150 and sized when the renderer
// first draws, so wait for the size rather than for the element.
const canvas = await page
  .waitForFunction(
    () => {
      const c = document.getElementById("world-canvas");
      return (
        c instanceof HTMLCanvasElement && c.width >= 1000 && c.height >= 600
      );
    },
    null,
    { timeout: timeoutMs },
  )
  .then(() =>
    page.$eval("#world-canvas", (c) => ({ width: c.width, height: c.height })),
  )
  .catch(() => null);
ok(
  canvas !== null && canvas.width >= 1000 && canvas.height >= 600,
  `the map canvas exists at window size (${canvas ? `${canvas.width}x${canvas.height}` : "missing"})`,
);

const clock = await page
  .waitForFunction(
    () =>
      /Day \d+ · \d\d:00/.test(
        document.querySelector("#world-menu .clock")?.textContent ?? "",
      ),
    null,
    { timeout: timeoutMs },
  )
  .then(() => page.$eval("#world-menu .clock", (c) => c.textContent))
  .catch(() => null);
ok(
  clock !== null,
  `the bar shows the in-game day and hour (${clock ?? "no clock"})`,
);

const economy = await page
  .$eval("#world-economy", (p) => (p.hidden ? null : p.textContent))
  .catch(() => null);
ok(
  // The label carries a circled "i" (the info button) between it and the number.
  economy !== null && /Construction\s*i?\s*[\d.]+\/day/.test(economy),
  "the economy panel is open and shows construction per day",
);
ok(
  economy !== null &&
    economy.includes("click one of your provinces on the map"),
  "and says where to build",
);

// The camera frames the nation's own territory, so the centre of the window
// is very likely one of its provinces — and any province opens the panel.
await page.mouse.click(700, 450);
const province = await page
  .waitForFunction(
    () => document.getElementById("world-province")?.hidden === false,
    null,
    { timeout: 10000 },
  )
  .then(() => page.$eval("#world-province", (p) => p.textContent ?? ""))
  .catch(() => null);
ok(
  province !== null && /Held by/.test(province),
  "a click on the map opens the province panel",
);
ok(
  province !== null && /Build|Attack this province/.test(province),
  "and it offers a build menu or an attack — the door is there",
);

ok(
  frames.includes("welcome"),
  `the socket was welcomed (${frames.slice(0, 3).join(", ")})`,
);
ok(
  frames.includes("full") && frames.includes("delta"),
  "and a full state and a delta arrived",
);

const fatal = await page
  .$eval("#world-error", (box) => box.textContent ?? "")
  .catch(() => null);
ok(
  fatal === null,
  fatal === null ? "no fatal screen" : `fatal screen: ${fatal}`,
);

const seriousErrors = errors.filter((e) => !/GL Driver Message/.test(e));
ok(
  seriousErrors.length === 0,
  seriousErrors.length === 0
    ? "no page error and no console error"
    : `page errors: ${seriousErrors.slice(0, 3).join(" | ")}`,
);

if (screenshot !== undefined) {
  await page.screenshot({ path: screenshot });
  console.log(`  screenshot: ${screenshot}`);
}
await browser.close();
console.log(`  ${Date.now() - started} ms in the browser`);
console.log(failed === 0 ? "PASS" : "FAIL");
process.exit(failed === 0 ? 0 : 1);
