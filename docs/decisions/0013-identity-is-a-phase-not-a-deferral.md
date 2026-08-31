# 0013 — Identity is a phase of its own, ahead of deployment

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 7

## Context

Since phase 1 a session has said which nation it is and the server has believed
it. The nation comes from `?nation=` in the URL, there is no credential, and
two sessions may hold the same nation at once. That was a deliberate deferral,
written down at `ClientHelloSchema`, and through phases 1 to 6 it was a
defensible one: the worst an impostor could do was queue buildings in somebody
else's provinces, and a hobby world on a laptop has no impostors.

Phase 7 changed what it is worth, and the phase-7 review is what made that
concrete.

`CLAUDE.md` §7 says: _"Diplomatic state, trust values, and agreement terms are
part of both. Trust is public to all nations; agreement terms are visible only
to the two parties."_ The server implements that line carefully — `agreementsFor`
strips `terms` from every agreement the session is not a party to, and the
stripping happens on the server rather than in the client, which is the right
place for it.

**And it is worth nothing**, because the session decides which nation it is. An
impostor asks to be nation 9 and is sent nation 9's treaty terms in full. It
can also send `cancel_agreement`, which spends trust that nation can never earn
back and stops a flow its real player was depending on. There is no bug in the
diplomacy code: from the server's side the impostor _is_ the nation.

## Decision

**Accounts become phase 11**, and deployment moves to phase 12.

Not a patch, and not a token bolted onto `hello`. The shape of the problem is
identity — which account holds which nation for the life of a season, what
happens when the same account connects twice, and what a session is allowed to
be told before it has proved anything — and a shared-secret sticking plaster
would answer the first question badly and the other two not at all.

The ordering is the load-bearing half of this decision. Deployment is what
makes the world reachable by anyone who is not Max, and **a world reachable
from outside with no accounts in front of it is a world in which anybody is
everybody**. Building them the other way round would mean either running a
public world with a known hole in it or taking it down again a week later.

## Consequences

- §8 has thirteen gates now, not twelve. Phase 11's gate is a _refusal_: a
  session that claims a nation it does not hold is refused and is sent nothing
  about that nation, and the refusal survives a world restart.
- It also answers §10's open question "how new players enter a world already in
  progress", because entering becomes something that happens to an account
  rather than to a URL.
- **Nothing before phase 11 should lean on identity being trustworthy.** Phase
  8's air zones and phase 9's naval zones are per-nation like everything else,
  and neither should grow a rule whose only enforcement is that the client
  would not do that.
- The gates connect as arbitrary nations and will keep working: whatever phase
  11 builds needs a way for a gate to authenticate, and that is part of its
  work rather than an afterthought.
- Until then the hole is real and is written down under "Anybody may claim
  anybody's nation" in the handover. It is safe only because the world runs on
  one laptop.
