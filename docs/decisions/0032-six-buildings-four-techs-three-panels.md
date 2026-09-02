# 0032 — Six buildings, four techs, three panels

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12; §6.1 (buildings), §6.4 (research), §9 (the UI)

## Context

The last of the simplification the player asked for, after decisions 0029
(one resource) and 0030 (three equipment types, two formations, four
missions). What was left: eight buildings, ten techs behind a dependency
graph, and six panels to look for one number in.

## Decision

**Six buildings.** The dockyard goes: one kind of factory builds everything
now, and a naval base already decides where a fleet can be raised, so a
second factory type was a second thing to build before you could build the
thing. The extraction upgrade goes with the fourth resource's bookkeeping —
a province yields what it holds, times the roads through it.

**Four techs, flat, no prerequisites.** §6.4 said this system should be the
cheapest thing in the game and stay that way; ten techs behind a graph was a
small tree pretending not to be one, and most of them were a percentage on a
number nobody was watching. The four left each change something a player can
watch happen: what a factory turns out, how fast an army fills, what a
defended province costs to take, and how many things you can research at
once.

**Three panels.** Build, Forces, Diplomacy — what you build with, what you
fight with, who you deal with. The sections inside a panel are stacked
rather than chosen between, so nothing was taken away except the choosing.

## Consequences

- `STATE_HASH_VERSION` 8 → 9, `PROTOCOL_VERSION` 20 → 21. A world in flight
  is translated: every province's building row is re-indexed and whatever
  stood in a dockyard slot is counted as a military factory, because it was
  a factory and the player paid for it. Techs that no longer exist are
  dropped from what a nation knows, and a slot researching one is emptied.
- **A migration bug this shook out, worth naming**: each step of the chain
  has to produce the shape of _its own_ era. Sizing every step to the newest
  shape truncated the ones in between, and a snapshot from hash 6 came back
  with no infrastructure at all. The tests now walk a snapshot through both
  steps rather than each alone.
- The regent's build order lost the dockyard and the mine and gained
  nothing: a coast wants a port, and everything else is factories.
