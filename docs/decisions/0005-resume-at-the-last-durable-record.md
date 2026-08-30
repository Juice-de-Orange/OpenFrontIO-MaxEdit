# 0005 — A world resumes at its last durable record, not at the tick it died on

- **Status:** Accepted
- **Date:** 2026-08-30
- **Phase:** 1

## Context

The world lives in memory. Two things about it are written down: every accepted
command, immediately, tagged with the tick it takes effect on; and a full
snapshot every 60 ticks. `CLAUDE.md` §4 rules out per-tick database writes —
17,280 ticks a day, and a tick is supposed to cost single-digit milliseconds.

That leaves a question the phase-1 gate asks directly. A world snapshots at
tick 120, takes a command for tick 135, and the process is killed at tick 137.
What tick does it come back on?

Measured in `tests/server/Restore.test.ts` against exactly that scene: the
restore lands on 135. Ticks 136 and 137 left no trace anywhere — no command,
no snapshot — and nothing in the durable record distinguishes "the world
reached 137" from "the world reached 135 and stopped".

## Decision

Resume at `max(newest snapshot tick, newest logged command tick)`, and treat
that as the world's current tick. The tick loop's epoch is then derived from
it, so the schedule restarts from there (see 0003).

Restore replays _ticks_, not commands: for every tick after the snapshot, the
commands logged for that tick are queued and `step()` is run. The world moves
on its own between commands, so applying the commands to the snapshot without
running the ticks in between lands somewhere else entirely.

## Alternatives rejected

- **Write the current tick every tick, so the exact death tick is known.** It
  is one small `UPDATE` rather than a snapshot, but it is still 17,280 writes a
  day per world for the sake of at most 60 ticks of a drift nobody can observe.
  It also buys nothing: knowing the world _reached_ 137 does not let us
  reconstruct what happened at 136 and 137, so we would resume at 137 with the
  state of 135 — worse than resuming at 135, because the tick number would then
  be a lie.
- **Snapshot every tick.** The write is a few kilobytes; the cost is a database
  round trip inside every tick and a snapshot table that grows 17,280 rows a
  day. It removes a loss that CLAUDE.md §4 has already accepted.
- **Replay from tick 0 instead of from a snapshot.** Exact, and it is what
  upstream's lockstep did. A six-week season is about 725,000 ticks; a player
  joining in week five cannot wait for that, and neither can a restart.

## Consequences

- A hard crash costs at most one snapshot interval — five minutes — of
  _simulated drift_, and **no player command**. That is the guarantee, stated
  precisely, and the restore test asserts it in that form rather than asserting
  a stronger one that does not hold.
- Game time is not real time and does not try to be (0003). Resuming two ticks
  "early" is invisible from inside the world: nothing outside the simulation is
  referenced by anything inside it.
- The command log has to be ordered by `(tick, seq)` and nothing else. The
  database's own insertion order is the same thing only until a write is
  retried, so `seq` is recorded explicitly and the runner checks that the slot
  it logged is the slot it queued.
- Shortening the snapshot interval shortens the worst case linearly. It is one
  number in `shared/config/time.ts` and costs one write per interval.
