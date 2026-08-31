/**
 * The air, and what superiority over a zone is worth.
 *
 * CLAUDE.md §6.7. Provinces are partitioned into air zones by the map
 * generator (phase 2), a player assigns wings from an air base to a zone plus
 * a mission, and every tick the zone is resolved into a **superiority ratio**
 * per nation. That ratio then modifies three things that already exist:
 * ground combat strength, supply throughput, and factory output.
 *
 * Every one of the three degrades and none of them blocks (invariant 2). Total
 * air superiority does not stop an enemy factory or cut a supply line to zero;
 * it makes both worse, by a bounded amount, for as long as it is held. The
 * caps below are what "bounded" means, and they are deliberately modest: air
 * is a thumb on the scale of a war fought on the ground, not a way to win one
 * without troops.
 *
 * The numbers are per tick, like every other rate in `shared/config` — the UI
 * multiplies by 24 and labels it per day (invariant 9).
 */

/**
 * How far a wing reaches from the base it flies out of.
 *
 * A formation may be assigned to the zone its air base stands in, and to any
 * zone bordering that one. Not unlimited, because then where a player builds
 * an air base would not matter and invariant 8 — the province is the unit of
 * interaction — would be decoration. Not a distance solver either: zone
 * adjacency comes free from the province graph, it is static map data, and it
 * gives the choice of base a consequence a player can see on the map.
 */
export const ZONE_REACH = 1;

/**
 * The floor under a contested zone's superiority ratio, and its ceiling.
 *
 * Superiority is `own / (own + theirs)`, so it is 0.5 when two air forces are
 * matched and 1 when one side is alone in the sky. It is clamped away from
 * both ends because an air force that is outnumbered ten to one is not worth
 * *nothing* — its remaining wings still make the other side look up — and
 * because an unopposed one should not get quite the full effect either. The
 * clamp is what keeps the last wing in a losing war worth flying.
 */
export const SUPERIORITY_FLOOR = 0.05;
export const SUPERIORITY_CEILING = 0.95;

/**
 * What a tick over a contested zone costs a wing, as a share of what it holds.
 *
 * Paid by everything in the zone, on every mission — a bomber over hostile
 * ground is being shot at whether or not it came to fight. The losing side
 * pays up to `AIR_LOSS_SWING` more, so being outmatched in the air is
 * expensive in exactly the way §6.3 wants: the losses are equipment, they come
 * out of the stockpile, and the factories have to make them again.
 */
export const AIR_LOSS = 0.02;
export const AIR_LOSS_SWING = 0.03;

/**
 * A zone with nobody contesting it costs nothing to hold.
 *
 * Patrolling empty sky is free, or a player who wins the air war outright is
 * punished for having won it. Attrition against no opponent belongs to supply
 * (§6.6), which is already charging the base's province for the wings.
 */
export const AIR_LOSS_UNCONTESTED = 0;

/**
 * How much `ground_support` can move a ground battle, at most.
 *
 * Multiplies the attacker's strength by `1 ± GROUND_SUPPORT_SWING`, so a side
 * with the sky and bombers over the front presses about a fifth harder, and
 * one being bombed presses about a fifth less. This is the number phase 8's
 * gate measures, and §8 asks only that it be *measurable* — a fifth is well
 * clear of the ±20% the combat roll already swings by over a long enough
 * window, and small enough that air never decides a fight on its own.
 */
export const GROUND_SUPPORT_SWING = 0.2;

/**
 * How much `interdiction` can cut supply throughput, at most.
 *
 * §6.6's supply is reach times coverage; interdiction scales the result. A
 * quarter is enough to turn a stretched offensive into a stalled one — which
 * is the same lever phase 6's gate already proves works — without ever
 * starving a front that is otherwise well supplied.
 */
export const INTERDICTION_MAX = 0.25;

/**
 * How much `strategic_bombing` can cut factory output, at most.
 *
 * §6.6 of the design brief is invariant 6: every hostile action has an
 * economic footprint. This is the most direct one in the game — a wing over an
 * industrial zone is a wing taking factories off the board without a single
 * province changing hands. A fifth, because it is paid every tick it is held
 * and compounds over the in-game weeks a season runs.
 */
export const STRATEGIC_BOMBING_MAX = 0.2;

/**
 * How much mission power it takes to be half as effective as possible.
 *
 * A mission's raw power — wings on the job, weighted by what their template is
 * worth at it — saturates as `power / (power + MISSION_SATURATION)`. Two full
 * wings is half of what the mission can do, six is three quarters, and there
 * is no number of wings that reaches all of it. Diminishing returns for the
 * same reason `COMBAT_WIDTH` exists on the ground: without them the answer to
 * every zone is one more wing, and allocation stops being a decision.
 */
export const MISSION_SATURATION = 2;

/**
 * How much of a mission's effect survives without air superiority.
 *
 * A mission's strength is scaled by `MISSION_FLOOR + (1 - MISSION_FLOOR) ×
 * superiority`, so bombers sent into a sky somebody else owns still do
 * something — badly. Degrade, never block: the alternative is a player whose
 * whole air force does literally nothing because it is outnumbered, which is
 * the wall invariant 2 exists to prevent.
 */
export const MISSION_FLOOR = 0.2;

/**
 * The manpower one wing costs to raise.
 *
 * Ground crew, not pilots — a wing is a formation, and §6.10's manpower model
 * is a population-scaled cap (decision 0008) rather than a headcount. Cheaper
 * than a division because the expensive part of an air force is the aircraft,
 * and those come out of the stockpile.
 */
export const WING_MANPOWER = 500;
