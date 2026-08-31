# 0008 — Manpower is a population-scaled cap, not a conscription law

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 4

## Context

`CLAUDE.md` §10 lists the manpower model as open: "conscription laws, or a
simple population-scaled cap". Phase 4 raises divisions, and a division has to
cost something other than equipment, so the question stops being open.

## Decision

A population-scaled cap.

- Every province a nation both **owns and holds** contributes
  `tileCount × MANPOWER_PER_TILE` to that nation's manpower ceiling.
- The pool regrows toward the ceiling at a fixed share of it per tick.
- Losing land lowers the ceiling, and the pool is cut to it in the same tick.
  Growth is the slow direction; loss is not — the men were in the province that
  changed hands.
- Raising a division costs `DIVISION_MANPOWER`. Disbanding one returns its
  equipment to the stockpile and none of its men.

Occupied territory conscripts for nobody: not for the occupier, who has no
claim on the people there, and not for the owner, who is not in the room. That
is why the contribution needs owner _and_ controller to agree, unlike the
economy, where the holder collects at a reduced rate.

## Alternatives rejected

- **Conscription laws.** The obvious HoI4 answer, and the one §10's own
  exclusion list rules out by implication: laws only work if something gates
  them — political power, stability, war support — and §10 excludes the
  politics layer that would gate them, because adding one "would touch nothing
  else in the game". Ungated, a law is a free lunch, and it fails invariant 6
  the same way economy laws do.
- **Manpower as a fifth resource.** Tempting, because the extraction machinery
  already exists. Rejected because it would then be tradeable, and a nation
  buying an army on the world market is a different game. The four resources
  are materials; men are not.
- **A flat pool per nation.** Would make conquest worth nothing in the one
  currency a war is actually fought in.

## Consequences

- Territory is the army. A nation that loses half its provinces cannot replace
  its losses, which is the pressure the whole conquest loop needs and which no
  other system in the game currently supplies.
- Manpower is in the snapshot and in the state hash, like every other number
  the simulation owns.
- It gives phase 6 somewhere to put attrition and phase 10 something for the
  regent to be careful with, without either having to invent a new resource.
