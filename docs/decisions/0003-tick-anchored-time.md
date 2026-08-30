# 0003 — Time is tick-anchored; downtime is never re-simulated

- **Status:** Accepted
- **Date:** 2026-08-30
- **Phase:** 1

## Context

One tick is five seconds of wall clock and one in-game hour. A world runs for
weeks. Servers restart, hosts reboot, deployments happen.

If the tick schedule is anchored to the wall clock, a three-hour outage means
2,160 ticks are owed. The world would then simulate three in-game months in
seconds: production consumed, attrition applied, fronts collapsing, with nobody
able to intervene. A two-day outage would be 34,560 ticks. The failure mode
scales with the outage, which is exactly backwards — the longer something is
broken, the more damage the recovery does.

## Decision

Anchor the schedule to the tick number. On every start the epoch is set to
`now - currentTick * tickMs`, so the world resumes at the tick it stopped at.

Catch-up therefore only ever covers overload _within_ a run — a GC pause, a slow
tick — never downtime. Running away after an outage is structurally impossible
rather than bounded by a limit somebody has to tune.

Deadlines are computed absolutely from the epoch, not incrementally, so a tick
that fires 300 ms late does not shift the next one. `setInterval` is unsuitable:
it accumulates drift and fires uncontrolled bursts after a delay.

## Alternatives rejected

- **Wall-clock anchored with unbounded catch-up.** Keeps game time and real time
  in sync. Rejected for the failure mode above.
- **Wall-clock anchored with a catch-up cap** (say, at most 12 ticks). Bounds the
  damage but does not remove it, and introduces a tuning knob whose correct value
  is unknowable in advance. It also leaves game time silently diverging from real
  time anyway, so it pays the cost of both models.

## Consequences

- Game time drifts from real time. Nothing references real time, so nothing
  breaks: notice periods count in ticks, the dead-partner rule counts in in-game
  days.
- A player who logs off loses nothing to an outage they were not present for.
- The tick number is the only clock the simulation sees, which is also what makes
  replay from the command log reproduce a run exactly.
- Anything that _should_ track real time — "last seen", session expiry — must use
  a timestamp explicitly and must live outside the simulation.
