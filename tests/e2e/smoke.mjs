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
 *
 * **On a season world it watches, unless told to claim.** Playing a nation on
 * a season world registers an account and claims the nation for the whole
 * season (decision 0019) — and the first run of this script against the
 * deployed world did exactly that, with a token in a browser profile that was
 * thrown away seconds later. The claim had to be deleted by hand. So the
 * script asks `GET /register` first: on a season world it opens the page as a
 * spectator and marks the nation-only checks as skipped, and only
 * `--claim` makes it play — which is a thing to do on purpose, never by
 * default.
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
// Play a nation on a season world. Off by default: see the header.
const claim = args.get("claim") === "true";
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
// The same question the client asks before it plays: is this a season world?
let season = false;
try {
  const offer = await fetch(`${client}/register`, {
    signal: AbortSignal.timeout(3000),
  });
  if (offer.ok) season = (await offer.json()).season === true;
} catch {
  // no /register: a workbench world, or an older server
}
const playing = !season || claim;
if (season && !claim) {
  console.log(
    "  a season world: watching, not claiming (pass --claim to play a nation, which holds it for the season)",
  );
}
function skipped(text) {
  console.log(`  skip  ${text} (watching a season world)`);
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
      // **The drawing buffer is thrown away after every composite** unless
      // this is set, and then `drawImage` from the WebGL canvas reads black.
      // The zone-overlay check below is a before/after of real pixels, so
      // the test asks for the buffer to be kept — a test-only attribute,
      // set here rather than in the renderer, where it would cost every
      // player a frame's memory for nothing.
      if (type === "webgl2" || type === "webgl")
        attrs.preserveDrawingBuffer = true;
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
await page.goto(playing ? `${client}/?nation=${nation}` : `${client}/`, {
  waitUntil: "load",
});
if (!playing) {
  // A season world opens on the nation chooser; watching is a click away and
  // needs no account (decision 0022). The name field is on the way past it
  // (decision 0024) — a watcher never sends it, but it has to be there and
  // it has to take what is typed.
  try {
    await page.waitForSelector("#world-start .name input", {
      timeout: timeoutMs,
    });
    await page.fill("#world-start .name input", "Smoke Testerin");
    const typed = await page.$eval("#world-start .name input", (i) => ({
      value: i.value,
      label: i.closest(".name")?.querySelector(".label")?.textContent ?? "",
    }));
    ok(
      typed.value === "Smoke Testerin" && typed.label.length > 0,
      `the chooser asks for a name and keeps what is typed ("${typed.label.trim()}")`,
    );
  } catch {
    ok(false, "the chooser asks for a name");
  }
  try {
    await page.click("#world-start .watch", { timeout: timeoutMs });
  } catch {
    console.log(
      "  no chooser appeared to watch from — the checks below will say what did",
    );
  }
}

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
if (playing) {
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
} else {
  skipped("the economy panel shows construction per day");
  ok(
    economy !== null && /Watching/.test(economy),
    "the economy panel says the session is watching",
  );
}

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
if (playing) {
  ok(
    province !== null && /Build|Attack this province/.test(province),
    "and it offers a build menu or an attack — the door is there",
  );
} else {
  skipped("it offers a build menu or an attack");
}

// **The zone overlay, in pixels.** `z` toggles the air and sea zone layers
// (§6.7, §6.8). Nothing in the DOM says whether they drew, so the check
// counts pixels of the overlay's own colours before and after the key —
// which is the bug this catches, the overlay's first colour being a blue
// nobody could see under the territory fill.
//
// **Zoomed out first.** An air zone is fifteen to thirty provinces, so the
// opening camera sits inside one and no zone border crosses the window at
// all; the first version of this check pressed `z` at the home view, saw
// the same pixels twice and called a working overlay broken.
const overlayPixels = () =>
  page.evaluate(() => {
    const c = document.getElementById("world-canvas");
    if (!(c instanceof HTMLCanvasElement)) return null;
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let found = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      // Pale cyan over land (190,245,255) and pale sand over the sea
      // (255,250,200) — ZoneBorders.ts, and nothing else on the map is light.
      if (b > 210 && b - r > 20 && g - r > 8) found++;
      else if (r > 220 && g > 215 && b > 140 && b < 210) found++;
    }
    return found;
  });
await page.mouse.move(700, 450);
for (let i = 0; i < 25; i++) {
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(1200);
const beforeZ = await overlayPixels().catch(() => null);
await page.keyboard.press("z");
await page.waitForTimeout(1500);
const afterZ = await overlayPixels().catch(() => null);
ok(
  beforeZ !== null && afterZ !== null && afterZ > beforeZ + 50,
  beforeZ === null || afterZ === null
    ? "z draws the zone overlay (the canvas could not be read)"
    : `z draws the zone overlay over the map (${beforeZ} → ${afterZ} overlay pixels)`,
);
// Back off, and back in, so the screenshot below is the ordinary map.
await page.keyboard.press("z");
for (let i = 0; i < 25; i++) {
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(40);
}

// **The circled i.** Nineteen explanations hang off these buttons and the
// panel is rebuilt every tick, so the click has to survive the rebuild.
const help = await page
  .evaluate(() => {
    const button = document.querySelector("#world-hud button.info");
    if (!(button instanceof HTMLButtonElement)) return null;
    button.click();
    const key = button.dataset.help ?? "";
    const text =
      button.closest("div")?.parentElement?.querySelector(".help")
        ?.textContent ??
      document.querySelector("#world-hud .help")?.textContent ??
      "";
    return { key, text };
  })
  .catch(() => null);
ok(
  help !== null && help.text.trim().length > 20,
  help === null
    ? "a circled i opens an explanation (no info button found)"
    : `a circled i opens an explanation (${help.key}: "${help.text.slice(0, 40).trim()}...")`,
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
