---
name: run-openfront
description: Start this fork's world server and client locally and reach them from the command line — compose stack, /health, the Vite dev server, and playing a nation via ?nation=. Use when asked to run the game, start the dev server, or check that a change works in the real app. Read the "Driving a browser" section before attempting any headless automation; the driver in this directory targets the deleted upstream client and does not work.
---

This is a **persistent-world fork**. The upstream game — lobby, map picker,
singleplayer, a spawn phase, a client-side turn loop — was deleted in phase 0.
The server is authoritative and the client is a renderer. Anything that talks
about starting a match does not apply here.

All paths are relative to the repository root.

## Running it

The world needs a database. The compose stack is the documented path:

```bash
docker compose up -d          # Postgres, the world, and the backup sidecar
curl -s localhost:3000/health # tick, lag, snapshot age, province count
npm run start:client          # the map, at http://localhost:9000
```

`/health` is the fastest way to know the world is alive. A healthy Europe world
reports `"provinces": 677`, `"healthy": true` and a `tick` that climbs by one
every five seconds.

Without Docker, `npm run dev` runs the client and the server in one process.
The server falls back to an in-memory store when `DATABASE_URL` is unset and
says so at startup — fine for looking at the client, useless for anything that
has to survive a restart.

To play a nation rather than watch, open `http://localhost:9000/?nation=17`
(any number from 1 to 52). Without the parameter the HUD says _"Watching. Add
?nation=&lt;n&gt; to the URL to play one."_ On a season world
(`WORLD_SEASON=open`) the nation needs a token instead; see decision 0019.

A gate script is the other way to drive a world — twelve of them live in
`scripts/`, each plays a real world over a WebSocket and prints what it
measured. They want `WORLD_TICK_MS=50`, and `HANDOVER.md` records what each one
proved.

## Driving a browser

**There is a browser leg now: `npm run test:e2e`** (`tests/e2e/smoke.mjs`,
Playwright, added 2026-09-01). It opens the real client against the running
world and checks what a person would see: the map canvas at window size, the
six menu buttons, the clock, the economy panel with numbers, a click on the map
opening a province panel with a build menu, a welcomed socket, and no error or
fatal screen. It wants the compose stack on :3000 and the Vite dev server on
:9000, and exits 2 with instructions when either is missing.

```bash
docker compose up -d && npm run start:client &
npm run test:e2e -- --nation=17 --screenshot=/tmp/world.png
```

`--screenshot` writes a PNG of the whole page, which is the cheapest way to
_look_ at a client change without a person. `--client`, `--health` and
`--timeout` override the defaults.

Two things it had to learn, both written in the script's header:

- **Headless Chromium only has software WebGL**, and `initGL.ts` refuses it —
  rightly, for a player. The script gives the page an init script that hides
  the renderer string and drops `failIfMajorPerformanceCaveat`. Test-side
  only; the client is not changed. And the spoofed string must not contain
  "software" — the first version did and gated itself.
- **The page's WebSocket connects fine from Playwright.** The old note that an
  automated Chrome fails at `/ws` was about the Claude-in-Chrome extension's
  sandbox, not about headless browsers.

The frames are slow under SwiftShader (a run takes ~30 s); the DOM is not what
is slow, and the DOM is what the checks read. WebGL _output_ — an icon on the
map, a front's tiles — is not checkable this way; only the screenshot shows it.

`driver.mjs`, `game.mjs` and `setup.sh` next to this file are upstream
leftovers that target the deleted client (lobby, `single-player-modal`,
`map-picker`, a spawn phase). Every selector in them resolves to `null`. They
are not the browser leg and should not be revived.
