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

A gate script is the other way to drive a world — eleven of them live in
`scripts/`, each plays a real world over a WebSocket and prints what it
measured. They want `WORLD_TICK_MS=50`, and `HANDOVER.md` records what each one
proved.

## Driving a browser

**There is no working browser automation in this repository, and the files next
to this one are not it.**

`driver.mjs`, `game.mjs` and `setup.sh` came from upstream (three commits, none
of them from this fork) and phase 0 moved 259 client files into `_legacy/`
without noticing them. They assume things that no longer exist:
`src/server/Server.ts`, a lobby to poll, a `single-player-modal`, a
`map-picker`, a `build-menu`, a spawn phase, a `GameView` with `ticks()` and
`myPlayer()`, and a 100 ms tick. Every DOM selector in them now resolves to
`null`: `index.html` contains one script tag and nothing else, and
`tests/architecture/QuarantineBoundary.test.ts` actively prevents the legacy
custom elements from ever being registered. `playwright` is not installed and
is not a dependency, so `driver.mjs` fails at its first import.

Two things in there are still worth reading if somebody rebuilds this:

- `launch()` in `driver.mjs` — plain Playwright bootstrapping, and its
  Linux library injection is guarded by an `fs.existsSync` so it is harmless
  elsewhere.
- The `rafIntervalMs` throttle. This fork still renders WebGL, so headless runs
  still go through SwiftShader and still starve the main thread.

**Before writing a new one, read `HANDOVER.md` under "What you have to look at
yourself".** It records the real obstacle, which is not the selectors: in an
automated Chrome the page's own WebSocket to `/ws` fails immediately while
Vite's HMR socket on the same origin connects. That is the problem to solve
first. Until it is solved, the checklist in that section is a human's job, and
items 0a–0f on it have never been seen by anyone.
