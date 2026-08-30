# Documentation

Three kinds of writing live here, and they answer different questions. Putting
the wrong thing in the wrong place is how documentation rots, so the split is
deliberate.

| Directory                        | Answers                       | Goes stale when                            |
| -------------------------------- | ----------------------------- | ------------------------------------------ |
| [`architecture/`](architecture/) | _How does it work right now?_ | the code changes                           |
| [`decisions/`](decisions/)       | _Why is it like this?_        | never — decisions are historical records   |
| [`deploy/`](deploy/)             | _How do I run it?_            | the deployment changes                     |
| [`upstream/`](upstream/)         | _What did we inherit?_        | never — it is a snapshot of the fork point |

Two documents deliberately live in the repository root instead:

- [`../CLAUDE.md`](../CLAUDE.md) — the design specification. Every system, every
  invariant, the build phases and their gates. It is what everything else
  answers to.
- [`../HANDOVER.md`](../HANDOVER.md) — the state of the work. Where we are, what
  is next, which traps have already been paid for. It goes stale fastest of
  anything here, so it carries a date and is rewritten rather than patched.

## The rules that keep this useful

**1. Architecture notes describe the present tense, never the plan.**
If a document says "will", it belongs in `CLAUDE.md` or a decision record. A
document that mixes what exists with what is intended is worse than no document
at all, because you cannot tell which half you are reading.

**2. Every non-obvious decision gets a record, written when it is made.**
Not later, not "when things settle". The reasoning is only fully available at
the moment of deciding; a week later you remember the conclusion and have
forgotten the alternative you rejected and why. See
[`decisions/README.md`](decisions/README.md).

**3. Measured numbers carry their date and their method.**
"The tick takes 40 ms" is worthless in six months. "Measured 2026-08-30 on the
Europe map, 795 provinces, `npm run perf`" can be re-checked and disproved.
Anything that cannot be re-measured the same way is an opinion, and should say
so.

**4. When something turns out to be wrong, correct it in place and say so.**
Strike the old claim, state the new one, date it, and name the evidence. Do not
silently overwrite — someone (including a future you) may have built on the old
version and needs to see that it moved.

**5. Docs are updated in the same commit as the change they describe.**
A phase that passes its gate updates `architecture/`. A decision taken during
that work gets its record. If that feels like too much friction for a small
change, the change probably did not need a doc update either.

**6. Assume the reader is competent and has no context.**
This repository is public and someone else may want to host or extend it. Write
for a capable stranger: no in-jokes, no "as discussed", no references to
conversations they cannot read.

## Checking that it still holds together

```bash
npm run check:doc-links
```

Verifies that every relative link in every Markdown file resolves. Moving a
document leaves links that still look correct in a diff and only break for the
next person to follow them — which is exactly the reader with the least
context. It runs in a second; run it after moving or renaming anything.

**One trap worth knowing:** a file named `CLAUDE.md` anywhere in the tree is
loaded automatically as project instructions. Upstream's developer notes were
named that and claimed the simulation runs on each client — the opposite of
this design. They are now `docs/upstream/upstream-dev-notes.md`. Before adding a
file with that name, be sure you want its contents treated as instructions.

## What must never be written down here

This repository is **public**. The following belong in `*.local.md` files,
which are git-ignored by construction:

- Host names, IP addresses, ports and paths of a specific deployment
- Anything from a `.env`: tokens, passwords, API keys, connection strings
- Backup locations, monitoring endpoints, alerting topics
- Player account data, world snapshots, database dumps

The rule of thumb: if it would only be useful to someone attacking a specific
machine, it is not documentation, it is a liability. Deployment guides in
`deploy/` describe _a_ host generically; `deploy/HOST.local.md` describes
_the_ host and never leaves the machine it was written on.
