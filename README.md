# OpenFront MaxEdit

**A persistent-world fork of [OpenFront.io](https://openfront.io/) — the same map, a
completely different game underneath.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Assets: CC BY-SA 4.0](https://img.shields.io/badge/Assets-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
[![Upstream: OpenFrontIO](https://img.shields.io/badge/fork%20of-openfrontio%2FOpenFrontIO-informational.svg)](https://github.com/openfrontio/OpenFrontIO)

> This is **not** official OpenFront, and it is not affiliated with the OpenFront
> project or its maintainers. It is an independent hard fork.

## 💛 Why this exists

Because I love the original. OpenFront gets something right that most browser
strategy games don't — a map you actually want to look at, and expansion that
feels physical. This is a hobby project that asks a different question with the
same ingredients: _what if the world never stopped?_

Not a competitor, not a replacement. A weekend experiment that got out of hand,
built to be played by a couple of friends. If you find the idea interesting,
you are very welcome to join in — see [Contributing](#-contributing).

## 🌍 What is different

Upstream OpenFront is a fast, ephemeral match: a lobby fills, twenty minutes of
real-time expansion happen, someone wins, the game is deleted. The simulation
runs **on every client** in deterministic lockstep, and the server only relays
intents.

MaxEdit inverts almost all of that.

|                         | OpenFront                   | OpenFront MaxEdit                                                    |
| ----------------------- | --------------------------- | -------------------------------------------------------------------- |
| **World lifetime**      | one match, ~20 minutes      | one continuous world, running for weeks                              |
| **Who simulates**       | every client, in lockstep   | the server, alone                                                    |
| **The client is**       | a peer running the game     | a renderer with a state store                                        |
| **Time**                | real-time, ~10 ticks/second | one tick per 5 seconds = one in-game hour                            |
| **Unit of interaction** | tiles                       | provinces (300–800 per map)                                          |
| **Economy**             | gold and troops             | factories, construction points, four resources, equipment stockpiles |
| **Combat**              | tile-by-tile expansion      | front-based, at province borders, limited by combat width            |
| **When you log off**    | the match ends              | the world keeps running; a regent holds your nation                  |
| **Persistence**         | none                        | Postgres: append-only command log + periodic world snapshots         |

The design goal is a game you check on twice a day rather than play for twenty
minutes — closer to Hearts of Iron IV's economy than to an .io game, but with
the mechanics cut down to the few that carry their weight.

Three rules shape every system:

- **Everything is a rate, never a lump sum.** Factories produce per tick,
  construction accrues per tick. Nothing completes instantly.
- **Everything degrades, never hard-blocks.** A resource shortage scales output
  down proportionally. No system ever refuses to run; it runs worse.
- **You allocate, you don't micromanage.** Wings go to zones, factories go to
  production lines. You never command an individual aircraft.

The full design — every system, every invariant, and the reasoning behind the
ones that look arbitrary — is in [CLAUDE.md](CLAUDE.md).

## 🚧 Status

**Phase 7 of 11 done.** A world server ticks every five seconds, persists to
Postgres, accepts commands and comes back where it was after being killed. On
top of that runs an economy: provinces extract from their deposits, civilian
factories make construction points, military factories and dockyards draw the
materials of whatever their line is making, equipment accumulates in a national
stockpile, divisions draw it out, research moves the rates all of that reads,
supply decides how much of it reaches a division at the end of a long front,
and nations make standing agreements with each other — indefinite ones, paid
for in construction points, that cost trust to break and survive a restart
because nobody has to renew them. A shortage anywhere scales every consumer
down together; nothing ever stops. The inherited renderer draws it, and the world's own heartbeat is still
one province changing hands per tick.

The build order and the gate each phase has to pass are in
[CLAUDE.md § 8](CLAUDE.md). For the current state of the work — what is done,
what is next, and the traps already paid for — see
[HANDOVER.md](HANDOVER.md). Progress so far:

- [x] Fork triage — lockstep removed, renderer kept, world server stubbed
- [x] World persistence — tick loop, command log, snapshots, crash recovery
- [x] Province graph — partition, ownership from tiles, borders drawn
- [x] Factories and construction — building slots, a queue that accrues per tick
- [x] Production and equipment — lines, the efficiency ramp, a stockpile that drains
- [x] Research — slots, prerequisites, modifiers the systems read
- [x] Supply — reach over the province graph, coverage, attrition at the far end
- [x] Diplomacy and trade — indefinite agreements, trust, per-tick flows, a world market
- [ ] Air · Naval · Regent · Deployment

## 🤝 Contributing

Genuinely welcome. This is a small hobby project, so the bar is "does it fit the
design", not "is it perfect".

Useful things to know before you start:

- **Read [CLAUDE.md](CLAUDE.md) first**, especially § 2 (design invariants). A
  mechanic that needs an exception to those is the wrong mechanic, however good
  it is on its own — that constraint is what keeps the game coherent.
- **Phases are built in order** and each has a gate. A pull request for phase 8
  while phase 7 is unbuilt has nothing to attach to, and a phase counts as done
  when its gate has been _demonstrated_ — not when it compiles.
- Docs live in [`docs/`](docs/) — architecture notes, and a decision log
  explaining _why_ things are the way they are. [HANDOVER.md](HANDOVER.md) is
  the quickest way in: it names the next task and the mistakes not worth
  repeating.
- Conventional commits, phase number in the body.

Bug reports, balance opinions, and "this system is more complicated than it
needs to be" are all useful. So is telling me the design is wrong.

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) 24 and npm 10.9.2+
- A browser with WebGL2
- Docker (from phase 1 onward, for Postgres)

## 🚀 Installation

```bash
git clone https://github.com/Juice-de-Orange/OpenFrontIO-MaxEdit.git
cd OpenFrontIO-MaxEdit
npm run inst
```

Use `npm run inst`, **not** `npm install`. It runs `npm ci --ignore-scripts`,
which installs exactly the locked versions and runs no lifecycle scripts — a
cheap defence against supply-chain attacks. (Inherited from upstream, and worth
keeping.)

## 🎮 Running

```bash
npm run dev          # client + world server, http://localhost:9000
npm run start:client # client only
npm run start:server # world only, ws://localhost:3000/ws
npm test             # test suite (Vitest)
npm run typecheck    # tsc, plus typecheck:strict for shared/ and server/
npm run lint         # Oxlint + ESLint
npm run format       # Prettier
```

`npm run dev` needs no database: without `DATABASE_URL` the world keeps its
history in memory and says so. For a world that survives a restart:

```bash
docker compose up -d         # Postgres, and the world on port 3000
npm run start:client         # http://localhost:9000
npm run test:db              # the Postgres tests, skipped without a database
node scripts/phase1-gate.mjs # kill the world mid-run; check it comes back
```

Open `http://localhost:9000/?nation=1` to play a nation instead of watching,
and click a province bordering yours to claim it. There are no accounts yet.
[`docs/deploy/`](docs/deploy/) has the rest.

## 🏗️ Project structure

```
src/
  shared/     pure rules, map primitives, protocol schemas — no I/O,
              used by both sides
  server/     the authoritative world: tick loop, systems, persistence
  client/
    render/   the inherited WebGL2 renderer, kept
    world/    entry point, map loading, province index, frame adapter
  build/      build-time code (asset manifest and hashing)
resources/    maps, flags, fonts, translations
docs/         architecture notes and the decision log
zbin/         compact binary wire format for zod schemas (from upstream)
```

Upstream's `src/core` (the lockstep simulation) is being dismantled: the parts
worth keeping — map primitives, water pathfinding, the seeded PRNG — move to
`src/shared`, the rest is deleted. The renderer no longer imports any of it,
and it is no longer part of the shipped bundle; the rest of the inherited
client still compiles against it and is next in line.

## 🙏 Credits and license

This project exists because of the work of the OpenFront team and its
contributors, and before them [WarFront.io](https://github.com/WarFrontIO).

**© OpenFront and Contributors.** Source code is licensed under the
[GNU Affero General Public License v3.0](LICENSE); the licence requires that
this notice stays visible in modified versions, and that they are not presented
as the official project. Assets inherited from upstream are
[CC BY-SA 4.0](LICENSE-ASSETS). Licence history is in [LICENSING.md](LICENSING.md).

Upstream's proprietary assets — the OpenFront logo, brand font and music — are
**not** part of this fork and are not redistributed here.

Because MaxEdit is run as a network service, the AGPL requires its source to be
available to the people playing it. That is why this repository is public and
will stay public.
