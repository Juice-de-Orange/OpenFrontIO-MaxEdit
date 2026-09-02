/**
 * Production lines: what the factories and dockyards make, and how many of
 * each are on what.
 *
 * The rule that matters most is unchanged from the first regent: **an
 * existing line's equipment type is never changed** (§6.2). Lines are
 * opened — one per yard per visit, because the reducer hands out the id and
 * the line can only be staffed on the next visit — and factories are moved
 * between them. The ground lines come first, as before: a division's
 * strength is the worst ratio across its template, so rifles alone arm
 * nobody. Then the wings' lines once an air base stands, and the yards'
 * lines once the sea carries the supply.
 */

import { MAX_PRODUCTION_LINES } from "src/shared/config/limits";
import { EQUIPMENT, type EquipmentType } from "src/shared/economy/Equipment";
import type { WorldEvent } from "../../world/WorldState";
import type { Situation } from "./situation";

interface Wanted {
  equipment: EquipmentType;
  weight: number;
}

/**
 * The lines this steward wants on its military factories, with their weights.
 *
 * Two, where there were four (decision 0030): the ground always, and
 * aircraft once there is a base to fly them from and a reason to. What used
 * to be the choice between rifles and guns, and between fighters and
 * bombers, is now how many factories go on each of two lines — which is the
 * decision that was underneath both of them.
 */
function wantedMilitary(s: Situation): Wanted[] {
  const t = s.temperament;
  const lines: Wanted[] = [{ equipment: "infantry", weight: 1 }];
  if (s.bases.air.length > 0 && (t.air >= 0.4 || s.airThreat.size > 0)) {
    lines.push({ equipment: "aircraft", weight: 0.4 + t.air * 0.6 });
  }
  return lines;
}

/**
 * And on its dockyards: ships, when it has anything to do with the sea.
 *
 * One line, because there is one naval good. A merchant hull and a warship
 * hull are the same number now (§6.3), which is what makes raiding hurt
 * twice — the ships that carry your trade are the ships that guard it.
 */
function wantedDockyard(s: Situation): Wanted[] {
  const t = s.temperament;
  const wantsSea =
    s.sea.routes.length > 0 ||
    s.sea.island ||
    s.sea.convoysWanted > 0 ||
    (s.bases.naval.length > 0 && t.naval >= 0.5);
  return wantsSea ? [{ equipment: "ships", weight: 1 }] : [];
}

/**
 * Open the first wanted line that does not exist yet, or redistribute the
 * yard's factories over the lines that do — by weight, never below one
 * factory on the first of them, and never touching a line this steward did
 * not ask for (a player's, or an earlier temperament's) beyond leaving it
 * what it has.
 */
function staff(
  s: Situation,
  yard: "military_factory" | "dockyard",
  wanted: Wanted[],
): WorldEvent[] {
  const { me, nation } = s;
  void yard;
  const total = s.factories.military.total;
  if (total === 0 || wanted.length === 0) return [];
  const mine = me.productionLines.filter(
    (line) => EQUIPMENT[line.equipment].yard === yard,
  );
  // Open what is missing, one line a visit; the first wanted line first, but
  // the second ground line only once there is a second factory to put on it.
  for (let i = 0; i < wanted.length; i++) {
    const want = wanted[i];
    if (mine.some((line) => line.equipment === want.equipment)) continue;
    if (me.productionLines.length >= MAX_PRODUCTION_LINES) break;
    if (i > 0 && total < i + 1) break;
    return [
      { kind: "production_line_created", nation, equipment: want.equipment },
    ];
  }
  // Redistribute over the wanted lines that exist.
  const ours = wanted
    .map((want) => ({
      want,
      line: mine.find((line) => line.equipment === want.equipment),
    }))
    .filter(
      (it): it is { want: Wanted; line: (typeof mine)[number] } =>
        it.line !== undefined,
    );
  if (ours.length === 0) return [];
  const theirs = mine
    .filter((line) => !ours.some((it) => it.line.id === line.id))
    .reduce((sum, line) => sum + line.factories, 0);
  const budget = Math.max(0, total - theirs);
  const weightSum = ours.reduce((sum, it) => sum + it.want.weight, 0);
  const targets = ours.map((it) =>
    Math.floor((budget * it.want.weight) / weightSum),
  );
  // Rounding leaves a few idle: hand them to the lines in order, and keep
  // the first line at one factory at least.
  let spare = budget - targets.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < targets.length && spare > 0; i++) {
    targets[i]++;
    spare--;
  }
  // Every wanted line gets a factory when there are enough to go round —
  // the phase-6 lesson: a division's strength is its worst ratio, so a gun
  // line with nothing on it arms nobody however many rifles come off the
  // other. Taken from the fattest line, first line first.
  if (budget >= targets.length) {
    for (let i = 0; i < targets.length; i++) {
      if (targets[i] > 0) continue;
      let donor = 0;
      for (let j = 0; j < targets.length; j++) {
        if (targets[j] > targets[donor]) donor = j;
      }
      if (targets[donor] > 1) {
        targets[donor]--;
        targets[i] = 1;
      }
    }
  }
  const events: WorldEvent[] = [];
  // Decreases first, so no increase ever exceeds what is free at that moment.
  const changes = ours
    .map((it, i) => ({ line: it.line, factories: targets[i] }))
    .filter((it) => it.line.factories !== it.factories)
    .sort(
      (a, b) =>
        a.factories - a.line.factories - (b.factories - b.line.factories),
    );
  for (const change of changes) {
    events.push({
      kind: "production_factories_assigned",
      nation,
      lineId: change.line.id,
      factories: change.factories,
    });
  }
  return events;
}

export function production(s: Situation): WorldEvent[] {
  return [
    ...staff(s, "military_factory", wantedMilitary(s)),
    ...staff(s, "dockyard", wantedDockyard(s)),
  ];
}
