#!/usr/bin/env node
/**
 * Render the built `index.html` for a plain static host.
 *
 * `vite build` leaves EJS placeholders in it — `assetManifest`, `cdnBase`,
 * `gameEnv` and `cdnBaseRaw` — because upstream served the page from an
 * Express process that filled them per request. This fork has no such process:
 * §3 puts a reverse proxy in front of a static bundle and one WebSocket, and a
 * reverse proxy does not run a template engine.
 *
 * So the placeholders are filled once, at deploy time, with the values the
 * dev server uses (vite.config.ts). Leaving them in is not a cosmetic problem:
 * the module script tag's src becomes literal EJS, the browser fetches
 * nothing, and the page is blank with no error worth the name.
 *
 *   node scripts/render-index.mjs static/index.html
 *
 * Idempotent: a file with no placeholders left is reported and not rewritten.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const target = process.argv[2] ?? "static/index.html";
const dir = path.dirname(target);

const manifest = readFileSync(path.join(dir, "asset-manifest.json"), "utf8");
let html = readFileSync(target, "utf8");

// The same values vite.config.ts hands the dev server, with GAME_ENV set for
// a deployed world. CDN_BASE is empty because the bundle is served from the
// same origin as the socket.
const cdnBase = process.env.CDN_BASE ?? "";
const substitutions = [
  ["<%- assetManifest %>", manifest.trim()],
  ["<%- cdnBase %>", JSON.stringify(cdnBase)],
  ["<%- gameEnv %>", JSON.stringify(process.env.GAME_ENV ?? "prod")],
  [`<%- locals.cdnBaseRaw || "" %>`, cdnBase],
];

let replaced = 0;
for (const [from, to] of substitutions) {
  const count = html.split(from).length - 1;
  if (count === 0) continue;
  html = html.split(from).join(to);
  replaced += count;
}

if (replaced === 0) {
  console.log(`${target}: nothing to fill in`);
  process.exit(0);
}

// A placeholder this script does not know about would leave the page broken
// in exactly the way it exists to prevent, so it refuses rather than shipping.
const leftover = html.match(/<%[-=]?[^%]*%>/);
if (leftover !== null) {
  console.error(`${target}: unfilled placeholder ${leftover[0]}`);
  process.exit(1);
}

writeFileSync(target, html);
console.log(`${target}: filled ${replaced} placeholder(s)`);
