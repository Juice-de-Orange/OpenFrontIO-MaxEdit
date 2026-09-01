# 0022 — Which nations are taken is public; who took them is not

- **Status:** Accepted
- **Date:** 2026-09-01
- **Phase:** 11 (after the fact, when the world got a way in)

## Context

Until the world was deployed and played, the nation a session acted for came
from `?nation=` in the URL and nowhere else. That was fine for gates and for a
developer, and it made the world unenterable for anybody else: a visitor who
did not already know a number landed as a spectator, and every HUD panel hides
itself without a nation, so the six menu buttons pressed and showed nothing.
The player's report was "there is no sign-in and I cannot click any of the menu
items".

A chooser needs the list of nations, and it needs to know which entries are
dead ends. That is information about other people's accounts, and phase 11 was
deliberately built so that accounts live beside the world and tell nobody
anything (decision 0019). `Wire.ts` says as much for the simulation: the other
side's assignments are not on the wire.

There is also a trap in the middle. `?nation=` is deliberately never
remembered, so a browser can hold a token and not know which nation it bought.
If the chooser only knows "claimed or not", that player sees their own country
greyed out as taken and every other one refused with "your account already
holds a different nation" — locked out of the world by their own account, with
no way through.

## Decision

**`GET /register` answers the nation list with a `claimed` flag per nation, a
`season` flag, and — only when the request carries the asker's own bearer
token — the nation that account holds.**

- Claimed-or-not is **public**. It is not a secret in any useful sense: a
  nation being played rather than regent-run shows in its behaviour within an
  hour, and a chooser that cannot show it makes the player discover it by being
  refused, which is a worse interface and the same information.
- **Who** holds a nation is **never** answered. That is an account, and
  accounts are nobody else's business. A request with somebody else's token
  learns only about that account.
- It is `GET` on the path the registration already `POST`s to, not a new route.
  A reverse proxy has to be told about every path it forwards, and a chooser
  that works in development and 404s in production is worse than no chooser.
- On a workbench world (`season` false) nothing is claimed and nothing can be,
  and the answer says so rather than implying a commitment the world will not
  keep.

## Alternatives rejected

- **Put the claims on the wire, in `FullState`.** It is the natural home for
  world-visible facts, and it costs a protocol bump that disconnects every live
  client — for something the player needs _before_ connecting, which is
  precisely when there is no socket. The HTTP surface already exists for
  exactly this class of question.
- **Let the chooser offer every nation and let the socket refuse.** Honest, and
  it makes the player pick blind from 52 entries until one works. The refusal
  is a close code, so each attempt costs a connection.
- **Return the holder's account name too**, so the map could show who is
  playing what. Tempting, and it is a different decision with a different
  blast radius: names are user-supplied, there is no censor in this fork (the
  inherited one is quarantined), and decision 0019 keeps names out of the
  simulation entirely. Left to the step that adds a player name at all.
- **Answer nothing without a token.** Then a first-time visitor — the only
  person who needs the chooser — cannot use it.

## Consequences

- The world has an entrance. A visitor picks a nation, the client registers,
  the hello claims it, and the browser remembers it.
- A browser holding a token skips the chooser entirely: the endpoint tells it
  which nation is its own and the client walks straight back in. The lockout
  above cannot happen.
- One more store query, `nationOfAccount`, in all three implementations. It is
  the same row `claimNation` already reads on its conflict path.
- The answer is `cache-control: no-store`. Who holds what changes as people
  arrive, and a cached list hands a new player a nation that was taken ten
  minutes ago.
- **The endpoint must stay out of the simulation.** It reads Postgres and the
  world's nation list and writes nothing. If a later change makes claims part
  of `WorldState`, the state hash moves and the running season dies — the same
  rule decision 0019 already lives under.
