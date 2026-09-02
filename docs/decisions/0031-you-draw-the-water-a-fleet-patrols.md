# 0031 — You draw the water a fleet patrols

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** after 12; §6.7 (air zones), §6.8 (naval zones), invariant 4

## Context

The player, describing what he wanted the sea to feel like: _"vielleicht wie
in hoi4 dass man halt flotten hat und für die mehr schiffe kaufen kann und
dann eine region auswählt in der diese patroullieren (die soll man sozusagen
zeichnen können)"_.

Until now a formation was assigned to a zone by picking a number out of a
dropdown of thirty-one. That is not a decision about the sea; it is a lookup.
The zones are on the map behind `z`, so the information was there — the
player just could not point at it.

## Decision

**A drawn box is a zone.** A button on each formation puts the map into
draw mode for one gesture; the player drags a box over the water or the sky;
the client counts the tiles inside it, takes the zone that got the most
votes, and sends the assignment that was always going to be sent. A box that
straddles two zones means the one it caught most of, which is what somebody
drawing roughly around an area intends.

**The command does not change.** `assign_formation` still carries a zone id,
the server still validates reach and mission weight, and a replay still sees
exactly what it saw before. This is an input method, not a mechanic —
invariant 4 is untouched, because the player is still allocating a formation
to an area and never steering a ship.

**Invariant 8 is intact.** The tiles inside the box are a projection: they
vote, and then they are forgotten. What leaves the client is a zone.

**The rubber band is a `div`.** It exists for the half-second the gesture
lasts. A WebGL pass for a dashed rectangle would be three hundred lines that
nothing in this project's test setup can look at.

## Consequences

- A drawn area also picks the order: a fleet patrols the water it was given,
  a wing takes the sky over it. The other of the two missions stays on the
  panel's dropdown for anybody who wants it, so nothing is lost.
- The zone dropdown stays as well. Drawing is the way to say it; the list is
  the way to be exact, and the two produce the same command.
- `CameraController` grew a one-gesture draw mode and a `worldToScreen` to
  paint the band with. Both are small, and the mode clears itself on the
  gesture that ends it — there is no state to get stuck in.
