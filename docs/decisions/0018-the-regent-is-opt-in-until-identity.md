# 0018 — The regent is opt-in until phase 11, and its baseline is translated

- **Status:** Accepted
- **Date:** 2026-09-01
- **Phase:** 10

## Context

§6.10's regent exists so that a nation whose player is offline goes on being
played. Two questions had no answer in the specification, and both had to be
decided before the system could ship.

**One: who has a regent before accounts exist?** Until phase 11 there is no
such thing as a played nation — a session claims any nation in its `hello`,
and nobody claims most of them. A regent that defaults to _on_ therefore
plays all fifty-two nations at once, permanently. Decision 0014 spent real
effort making an unattended world quiet precisely so that gates can measure
one mechanic at a time; a default-on regent reverses that overnight, and
every existing gate — which stages armies, waits on manpower the regent would
spend first, and reads economies the regent would be rebuilding — becomes a
measurement of the regent instead of its subject.

**Two: what do "retreat units that are collapsing" and "keep units supplied"
mean in a world whose divisions cannot move?** §6.9 resolves borders, not
marches; a division stands where it was raised.

## Decision

`DEFAULT_REGENT.enabled` is **false**. The `configure_regent` command turns a
nation's regent on or off at any time, connected or not, and the phase-10
gate exercises exactly that path. When phase 11 gives the world accounts, the
season opening switches regents on for every nation no account holds — that
is where §6.10's "plays the majority of a nation's ticks" starts being true.

The baseline duties are translated rather than skipped:

- **"Retreat collapsing units"** becomes calling off a standing attack whose
  staging has crumbled — no division worth its keep next to the target. It
  is the only retreat the game has.
- **"Keep units supplied"** becomes building a supply hub in a starving
  division's province, ahead of any focus spending — the phase-8 gate's
  bottomless-pit lesson, applied by the steward the way a player would.
- **A garrison at home** is read into "competent at the basics": since the
  front became a rate, an empty capital is marched into in eight ticks by an
  attacker with no army at all, so the first thing the regent buys with its
  manpower is one division in the capital. The phase-10 gate's counter-proof
  is precisely this asymmetry: the same offensive takes an unguarded capital
  in 102 ticks and never takes a garrisoned one.
- **Both template lines, always.** A division's strength is the worst ratio
  across its template (§6.3), so a one-line nation arms nobody — the
  phase-6 gate's lesson. With two factories the regent runs rifles and guns
  together, artillery taking at least one factory and about a third.

## Alternatives rejected

- **Default on.** See above: it makes the regent the world, three phases
  early, and every gate would have had to be rebuilt around it in one night.
- **On for nations nobody has connected as** (`lastSeenTick`-based). Tempting
  and wrong: it makes simulation behaviour depend on socket history, the
  exact coupling decision 0011 exists to keep out of the systems, and it
  would still have flipped every gate's staging nation mid-run.

## Consequences

- An unattended world stays quiet (0014 holds) until a player or the season
  opening says otherwise. The demo world on the deployed host behaves as
  before.
- Phase 11 must remember to switch regents on for unclaimed nations, or
  §6.10's promise is silently unkept — this is written into the phase-11
  notes in HANDOVER.md.
- `tests/server/Regent.test.ts` holds the translations; the phase-10 gate
  holds §8's sentence.
