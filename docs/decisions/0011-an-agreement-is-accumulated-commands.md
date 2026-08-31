# 0011 — An agreement is accumulated commands, never a server-side side effect

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 7

## Context

`CLAUDE.md` §4 makes an unusually specific demand of diplomacy: agreements
"must be in the snapshot" and "must also be fully derivable from the command
log alone, so agreements are represented as accumulated commands, never as
server-side side effects".

That is easy to nod at and easy to break, because the natural way to write
half of §6.5 is a side effect. "Dissolve this agreement in a day" wants a
timer. "This nation has gone quiet" wants a clock. "The other side is
notified" wants a message queue. Each of those would put a piece of the
diplomatic state somewhere the command log cannot see, and a restore would
then come back with a world that looks right and has forgotten something.

## Decision

**Every agreement is a list of commands and nothing else.** Four commands make
and unmake one — `propose_agreement`, `accept_agreement`, `decline_agreement`,
`cancel_agreement` — and everything that happens to it afterwards is a pure
function of state that those commands already determined.

Concretely:

- **There is no timer.** `cancel_agreement` records the tick notice was given.
  `agreementIsLive` compares that tick with the current one. The agreement
  stops moving goods at `noticeAt + AGREEMENT_NOTICE_TICKS` because a
  comparison says so, not because anything was scheduled.
- **There is no notification.** The notice is a field on the agreement, and
  the agreement is on the wire in every delta to both parties. The other side
  is "notified immediately" in the only sense a persistent world can promise:
  the next state they are sent already says so.
- **There is no clock.** The dead-partner rule needs to know when a nation was
  last played, and a socket connection is not in the command log. So
  connecting _writes a command_ — `nation_present` — and every accepted
  command sets `lastSeenTick` as a side effect of being replayed. Presence is
  therefore a fact the log records, and a replay reaches the same conclusion
  about who was around as the original run did.

## The one that is easy to get wrong

`nation_present` looks like protocol noise in the command log and it is not.
Without it, "no player login for fourteen in-game days" is measurable only
from the socket layer, which is exactly the "server-side side effect" §4
forbids: a world restored from its log would dissolve a different set of
agreements from the world that wrote it, and neither would be wrong in any way
the state hash could see.

A connected session writes one every `PRESENCE_REFRESH_TICKS`, so a player who
is watching rather than clicking still counts as present.

## Consequences

- Diplomatic state is in the snapshot **and** in the state hash. A world that
  came back having forgotten a promise fails the phase-1 restore gate, which
  is where it should fail.
- An offer to a nation nobody has played is refused at validation rather than
  dissolved a tick later. The rule that would have swept it up is the same
  rule; refusing it means the player is told, which is §7's whole position on
  silent failure.
- **A restore can roll a dissolution back, and that is correct.** The replay
  stops at the last command in the log, so a change made by a _system_ after
  that — a notice running out, a dead partner being written off — is undone by
  a crash and then happens again, at the same tick, on the way back up.
  Deterministic, and bounded by the snapshot interval like every other
  system's work. The phase-7 gate's `--break=survives` counter-proof had to
  learn this: it now waits for a snapshot to carry the dissolution before it
  kills the world.
- Trust is a number on a nation, changed only by `trust_changed` events that
  only `cancel_agreement` emits. Nothing decays it and nothing grants it back,
  which is a balance question left open rather than answered here.
