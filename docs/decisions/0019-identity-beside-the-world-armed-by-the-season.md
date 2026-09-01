# 0019 — Identity lives beside the world, and the season is what arms it

- **Status:** Accepted
- **Date:** 2026-09-01
- **Phase:** 11

## Context

Phase 11 had to add accounts without breaking two things phase 1 built and
every phase since has leaned on: a simulation that replays from the command
log alone, and a workbench world any script may play. A naive design injures
both — accounts in the world state make replays depend on login history, and
a credential required on every `hello` breaks all eleven existing gates and
strands every rerun behind the claims of the run before it.

## Decision

**Identity lives beside the world, never in it.** Accounts and nation claims
are two Postgres tables (`accounts`, `nation_claims`) consulted by the socket
layer; nothing about them enters the snapshot, the state hash, or the
simulation. The credential is an opaque token from `POST /register`, returned
exactly once, stored only as a SHA-256 hash — a database dump leaks nothing a
session could log in with. There is no password and no recovery: a lost token
is a new account, which is the right weight for a hobby world.

**`WORLD_SEASON=open` is what arms it.** On a season world, playing a nation
requires a token; the first authenticated `hello` naming a free nation claims
it (§10's "new players take a nation no account holds"); one account holds
one nation and one nation is held by one account, enforced as unique indexes
so racing sessions meet the rule in the database, not in a check-then-insert;
a newer connection from an account supersedes the older one (close code 4006,
terminal, so two auto-reconnecting browsers cannot kick each other for ever);
and the season opening switches regents on for every unclaimed nation — the
half decision 0018 promised. Without the flag, the world is the workbench it
has always been: anyone may be anyone, no claims accumulate, and every gate
and local loop keeps working untouched.

**One reach into the simulation, through the front door.** The season opening
enables regents via `submit` — real `configure_regent` commands in the log —
so a replay reaches the same world without ever reading the accounts table.

## Alternatives rejected

- **Credentials always required.** Breaks every gate at once, and claims from
  one gate run would starve the next of nations. The phase-11 gate instead
  restarts the world into season mode, proves the rules, and restores the
  workbench — identity is tested exactly where it is armed.
- **Claims inside the world state.** Puts login history into the snapshot and
  the hash; a replay would need the accounts table, which is the coupling
  decision 0011 spent effort keeping out.
- **Sessions shared between two live browsers.** "Share one nation and one
  session" is satisfied by supersession, and supersession has one honest
  owner of the socket at every moment; a shared session has two cursors and
  no story for conflicting commands.

## Consequences

- A deployment (phase 12) must set `WORLD_SEASON=open`, or the world stays a
  workbench where anybody is everybody — the exact state §8 warns about.
  This line is the deployment checklist's first item now.
- The token is the account. The client keeps it in localStorage; clearing
  the browser's storage on a season world means a new account and a new
  nation, because the old claim stands for the season.
- Gates registering accounts accumulate claims on a long-lived world; the
  phase-11 gate scans past them and says `docker compose down -v` when the
  nations run out.
