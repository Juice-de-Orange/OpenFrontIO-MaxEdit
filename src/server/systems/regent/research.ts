/**
 * Research: the slots stay filled, and what fills them is the temperament.
 *
 * There is no air or naval tech (techs.ts), so the lists differ on the one
 * question the tree asks: industry first, or the field? The scholar and the
 * builder take the bureau and the tools; the soldiers take the workshops
 * that fill wings and fleets faster and the trenches that make a garrison
 * hold. First available from the list, so a replay picks the same one.
 */

import {
  isAvailable,
  slotsFor,
  TECH_IDS,
  type TechId,
} from "src/shared/config/techs";
import type { Archetype } from "src/shared/config/temperament";
import type { WorldEvent } from "../../world/WorldState";
import type { Situation } from "./situation";

const INDUSTRY: readonly TechId[] = [
  "reinforced_concrete",
  "research_bureau",
  "machine_tools",
  "precision_tooling",
  "assembly_line",
  "excavation",
  "deep_mining",
  "field_workshops",
  "entrenchment",
];
const FIELD: readonly TechId[] = [
  "field_workshops",
  "entrenchment",
  "machine_tools",
  "assembly_line",
  "precision_tooling",
  "reinforced_concrete",
  "research_bureau",
  "excavation",
  "deep_mining",
];
const WALLS: readonly TechId[] = [
  "entrenchment",
  "field_workshops",
  "reinforced_concrete",
  "machine_tools",
  "assembly_line",
  "research_bureau",
  "precision_tooling",
  "excavation",
  "deep_mining",
];

export const RESEARCH_ORDER: Readonly<Record<Archetype, readonly TechId[]>> = {
  builder: INDUSTRY,
  scholar: INDUSTRY,
  warden: WALLS,
  marshal: FIELD,
  conqueror: FIELD,
  admiral: FIELD,
  airman: FIELD,
};

export function research(s: Situation): WorldEvent[] {
  const { me, nation } = s;
  const events: WorldEvent[] = [];
  const order = RESEARCH_ORDER[s.temperament.archetype];
  const unlocked = slotsFor(me.unlockedTechs);
  const running = new Set(
    me.researchSlots.map((slot) => slot.tech).filter((tech) => tech !== null),
  );
  for (let slot = 0; slot < unlocked; slot++) {
    if (me.researchSlots[slot].tech !== null) continue;
    const tech = [...order, ...TECH_IDS].find(
      (id) =>
        !me.unlockedTechs.includes(id) &&
        !running.has(id) &&
        isAvailable(id, me.unlockedTechs),
    );
    if (tech === undefined) break;
    events.push({ kind: "research_started", nation, slot, tech });
    running.add(tech);
  }
  return events;
}
