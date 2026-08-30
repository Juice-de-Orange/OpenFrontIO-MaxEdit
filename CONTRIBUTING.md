# Contributing

Contributions are genuinely welcome. This is a small hobby project built out of
affection for [OpenFront](https://openfront.io/), so the bar is _does it fit the
design_, not _is it flawless_.

> Upstream's contribution process — CLA, approved-issue workflow, governance —
> does **not** apply here. It is kept for reference in
> [`docs/upstream/CONTRIBUTING.md`](docs/upstream/CONTRIBUTING.md).

## Before you write code

**Read [`CLAUDE.md`](CLAUDE.md), especially section 2.** It lists nine design
invariants — everything is a rate rather than a lump sum, everything degrades
rather than hard-blocks, the player allocates rather than micromanages, and so
on. A mechanic that needs an exception to those is the wrong mechanic however
good it is on its own. That constraint is the whole reason the game holds
together, and it is the thing most likely to get a pull request turned down.

**Read [`HANDOVER.md`](HANDOVER.md).** It says what is being worked on right
now, what the next task is, and lists the traps that have already cost someone a
morning. It is the fastest way to avoid duplicated or wasted work.

**Phases are built in order.** `CLAUDE.md` section 8 defines eleven phases, each
with a gate it has to pass before the next begins. A contribution to phase 7
while phase 3 does not exist has nothing to attach to. Check the progress list
in the README first.

## What is especially useful

- **Bug reports** — with the map, the tick number and what you expected.
- **Balance opinions.** The numbers all live in `src/shared/config/` and are
  deliberately provisional; they will be retuned many times.
- **"This system is more complicated than it needs to be."** Genuinely wanted.
  The design errs toward cutting mechanics, and an argument for cutting one more
  is worth more than an argument for adding one.
- **Telling me the design is wrong.** Better now than in phase 9.

## Working on the code

```bash
npm run inst       # npm ci --ignore-scripts — never `npm install`
npx tsc --noEmit   # must be clean
npm run lint       # oxlint + eslint, must be clean
npm run format     # prettier
npx vitest run     # see the baseline note in HANDOVER.md
npm run build-prod # the real integration test
```

Conventions that are enforced or expected:

- **TypeScript strict, and no `any`** in `src/shared/` and
  `src/server/systems/`.
- **Simulation code is pure.** No I/O, no wall-clock reads, no `Math.random()`.
  Randomness comes from a seeded PRNG keyed on `(worldSeed, tick, contextId)` —
  the world has to replay identically from its command log, and anything else
  breaks that silently.
- **Every balance number lives in `src/shared/config/`**, never inline.
- **Conventional commits**, with the phase number in the body.
- **Documentation is updated in the same commit as the change.** A non-obvious
  decision gets a record in [`docs/decisions/`](docs/decisions/) — written when
  it is made, and never edited afterwards. See
  [`docs/README.md`](docs/README.md).

## Two things that will be rejected

- **Anything host-specific in the repository.** It is public. Host names, ports,
  paths, tokens and credentials belong in git-ignored `*.local.md` files.
- **Upstream's proprietary assets.** The OpenFront logo, brand typeface and
  music are All Rights Reserved and were deliberately removed. Do not
  reintroduce them, and do not add assets whose licence you have not checked.

## Licensing

By contributing you agree your code is licensed under
[AGPL-3.0](LICENSE) and any assets under
[CC BY-SA 4.0](LICENSE-ASSETS), matching the rest of the project. There is no
CLA.
