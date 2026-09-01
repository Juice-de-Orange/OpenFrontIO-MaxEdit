# 0020 — Victory blocs are transitive, and winning stops nothing

- **Status:** Accepted
- **Date:** 2026-09-01
- **Phase:** victory (between 11 and 12)

## Context

§10 decided the victory condition — 40% of all provinces held by an alliance
bloc for seven in-game days, else the highest-scoring bloc when six weeks run
out — but left two questions to the implementation, and HANDOVER.md asked for
the first by name: "an alliance is transitive for victory purposes, or it is
not — decide and write it down."

## Decision

**Blocs are connected components over live alliances.** Allied-with-my-ally
is in my bloc even without a direct treaty: shared victory eligibility is the
stated purpose of an alliance (§6.5), and a chain that wins together is what
the word "bloc" means. A solo nation is a bloc of one, so an empire that
trusts nobody can still win — it just gets no help. An alliance under notice
still binds until the notice lapses, exactly as it does everywhere else
(invariant 3: the exit cost is the lever, and it has not finished being paid).

**A bloc's hold is the _same_ bloc's hold.** The held-for counter belongs to
a member set, compared canonically; an alliance signed or broken mid-hold
makes a different bloc, and a different bloc has held nothing yet. This is
what keeps the seven days honest — a leader cannot swap partners on day six
and keep the clock.

**Winning stops nothing.** `season_won` is emitted once, the state remembers
it for ever (the reducer refuses a second), the wire tells everyone on every
tick — and the world goes on turning. Archiving the season and opening a
fresh world is an operator's act (phase 12), not a tick's: a simulation that
halts itself would turn the victory check into the one place a running world
can die of a rule.

**The score is §10's own list, weighted to all matter**: provinces ×1,
industry-per-tick ×10, trust ×0.2 — an economy and a kept word land in the
same range as a modest border war. The weights are balance numbers in
`shared/config/victory.ts`, expected to be retuned.

## Alternatives rejected

- **Direct-treaty blocs only.** Punishes exactly the diplomacy §6.5 wants:
  two nations allied to the same third would fight each other's victory.
- **Pausing or archiving the world on victory.** Couples the simulation to
  an operational act, and makes the victory system the only system that can
  stop the tick — a power nothing in §6 has.
- **Per-nation score with an alliance bonus.** §10 already names the failure:
  evaluating individuals makes alliances strictly self-defeating.

## Consequences

- `tests/server/Victory.test.ts` demonstrates all of it; there is no gate,
  because the system is pure state arithmetic and §8 numbers no phase for it.
- The season's end at `SEASON_TICKS` is tick-anchored (decision 0003), so a
  fast test world ends sooner by the same rule.
- The wire's `victory` view is public on every full state and delta: a bloc
  closing on 40% is the one fact every other nation needs to see coming.
