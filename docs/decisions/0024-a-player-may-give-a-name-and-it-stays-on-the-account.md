# 0024 — A player may give a name, and it lives on the account, never in the world

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12 (playability), HANDOVER "The next plan" step 5

## Context

Protocol 17 gave every nation a ruler's name derived from the world seed
(decision 0023), so the fifty-one regent-run nations have a face. A nation a
person plays had the same kind of face — a made-up persona — which is the one
case where it is wrong: there _is_ somebody, and the map should say who, if
they want it to.

Decision 0019 draws the line this has to respect: accounts live beside the
world. Nothing about them enters the snapshot, the state hash or the command
log, because a replay must never depend on login history. Decision 0022 left
"return the holder's account name" open on purpose, naming the blast radius:
names are user-supplied free text, and the inherited censor is quarantined.

The `accounts` table already had a `name` column; the client had been filling
it with "Anonymous" since phase 11.

## Decision

**The chooser asks for a name once, before the nation.** Optional: an empty
field is a choice to stay anonymous, and the regent's persona stands in.
The name is sent only with the registration and stored on the account, so a
browser that already holds a token is not asked again and cannot rename.

**One rule, one implementation, both sides** — `shared/protocol/PlayerName.ts`:
two to twenty-four characters after trimming and collapsing whitespace, from
letters of any script, digits, spaces, dots, apostrophes and hyphens. The
server applies it at `POST /register` and answers a refusal with the rule in
it; the client applies the same function as the player types, so a name the
server would refuse never leaves the browser. There is no filter for meaning,
only for shape: this is a hobby world with a few dozen players who know each
other's faces.

**The wire's `ruler` is where it shows.** On a season world the full state's
nation list carries the holder's name as the `ruler` of every claimed nation
whose account has a chosen name, read from the store at that moment. Nothing
new on the wire, no protocol bump, and — since a claim can arrive at any
moment and the full state is the only carrier of the list — a running client
learns of a new neighbour's name at its next reconnect, which HANDOVER already
accepted for claims themselves.

## Alternatives rejected

- **A rename endpoint.** A second write path to the account for a cosmetic,
  and the one place a player could put a second name past the rule after
  learning it. A lost token is a new account anyway (decision 0019); a wrong
  name is the same kind of small loss.
- **The name in the nation's state**, set by a command. Puts free text into
  the command log and the snapshot, which decision 0019 forbids, and would
  have moved the state hash for a display string.
- **A word list.** The inherited censor is quarantined with the rest of the
  legacy client, and a list of forbidden words in a public repository is a
  list of words to type. Shape, not meaning.
- **Asking every time the chooser opens.** The account has the name; asking
  again would imply it could change.

## Consequences

- `POST /register` refuses a malformed name with 400 instead of trimming it
  to 64 characters; an absent or empty name still registers as "Anonymous".
- `WorldStore.holderNames(worldId)` on both stores; `IdentityService` exposes
  it; `WsServer.sendFullState` is async and substitutes the `ruler`.
- The accounts already registered as "Anonymous" (every account before this
  decision) show the persona, by the same rule as an empty field. Nobody is
  renamed retroactively.
- A third use of the `ruler` field — anything beyond "persona or player" —
  wants its own field and a protocol bump, not a third meaning.
