/**
 * The wire protocol, in one file.
 *
 * JSON behind a single module, with a version in the handshake. The inherited
 * binary format (`zbin/`) is positional and carries no version field: its own
 * documentation warns that mismatched builds decode each other's messages
 * *silently wrong*. For twenty-minute matches deployed in lockstep that was a
 * reasonable trade. For a world that runs for six weeks while we deploy into
 * it, and whose players hold cached bundles, a silent misdecode is the most
 * expensive failure available.
 *
 * The payload is small — a few hundred provinces, a handful of ownership
 * changes per tick, two clients. If deltas grow from phase 4 on, this is the
 * one file that changes. The version handshake stays either way.
 *
 * Serialisation lives here too, so nothing anywhere else calls JSON.parse on
 * protocol data.
 */

import { z } from "zod";
import { BUILDING_TYPES } from "../economy/Buildings";
import { EQUIPMENT_TYPES } from "../economy/Equipment";

/**
 * Bumped whenever a message shape changes in a way an older peer would
 * misread. One integer, not a semver range: the only question is whether the
 * two sides agree.
 */
export const PROTOCOL_VERSION = 6;

/** WebSocket close codes, in the application-defined range. */
export const CloseCode = {
  ProtocolVersion: 4001,
  Malformed: 4002,
  UnknownWorld: 4003,
  NoHelloTimeout: 4004,
  Unauthorised: 4005,
} as const;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientHelloSchema = z.object({
  t: z.literal("hello"),
  protocolVersion: z.number().int(),
  worldId: z.string().min(1),
  /**
   * Which nation this session acts for, or null to watch.
   *
   * Phase 1 takes this at face value: there are no accounts yet, so a
   * connection claims a nation the way a local development client claims a
   * port. Authentication belongs with the account tables, not here, and
   * putting a placeholder token in the handshake now would only have to be
   * removed again.
   */
  nation: z.number().int().positive().nullable(),
});

/**
 * Claim a province for the sending nation.
 *
 * The first command, and the ancestor of the attack orders in phase 9: it
 * names a province, it is checked against the world the server actually holds
 * (the province exists, it borders territory the nation owns, it is not
 * already theirs), and it takes effect on a tick rather than on arrival.
 *
 * Note what is *not* here: no cost, no outcome, no resulting owner. CLAUDE.md
 * §7 — never trust a client-supplied cost, position or outcome. Everything the
 * server needs it computes itself.
 */
export const ClaimProvinceSchema = z.object({
  kind: z.literal("claim_province"),
  provinceId: z.number().int().nonnegative(),
});

/**
 * Put a building at the back of the nation's construction queue.
 *
 * The second and third command types, and the reason phase 3 did not need a
 * throwaway one: a command set of one hides whatever the next one will need.
 * What they needed, it turns out, is nothing new — the shape holds.
 *
 * As with `claim_province`, note what is *not* here: no cost, no duration, no
 * resulting building. The server has the same `BUILDINGS` table and computes
 * all of it (CLAUDE.md §7).
 */
export const QueueConstructionSchema = z.object({
  kind: z.literal("queue_construction"),
  provinceId: z.number().int().nonnegative(),
  building: z.enum(BUILDING_TYPES),
});

/**
 * Take one item back out of the queue, by its id.
 *
 * **Not by position.** A position is what a player clicks, and it is wrong the
 * moment anything else moves: two cancellations sent in the same five seconds
 * cancelled the wrong things, because the first shifts the queue and the
 * second then removes whatever slid into that slot — or is refused as out of
 * range, leaving an "accepted" ack and an order still sitting there.
 *
 * Progress on a cancelled item is lost. That is the cost of changing your
 * mind, and it is the only thing in this game that is.
 */
export const CancelConstructionSchema = z.object({
  kind: z.literal("cancel_construction"),
  orderId: z.number().int().positive(),
});

/**
 * Open a production line, or close one.
 *
 * A line is created empty and at the efficiency floor; factories are assigned
 * separately. Splitting the two is deliberate — assigning factories must never
 * touch the ramp (§6.2), and a single "create with N factories" command would
 * make the two look like one decision.
 */
export const CreateProductionLineSchema = z.object({
  kind: z.literal("create_production_line"),
  equipment: z.enum(EQUIPMENT_TYPES),
});

export const RemoveProductionLineSchema = z.object({
  kind: z.literal("remove_production_line"),
  lineId: z.number().int().positive(),
});

/**
 * Change what a line makes.
 *
 * **This resets its efficiency to the floor** (§6.2), which is the single most
 * expensive thing a player can do to themselves by accident. It is its own
 * command rather than a field on an assignment for exactly that reason: the
 * client can warn about this one and only this one.
 */
export const SwitchProductionLineSchema = z.object({
  kind: z.literal("switch_production_line"),
  lineId: z.number().int().positive(),
  equipment: z.enum(EQUIPMENT_TYPES),
});

/**
 * Set how many factories are on a line. Absolute, not a delta.
 *
 * Absolute because a delta applied twice — a double click, a retry after a
 * dropped ack — means something different from a delta applied once, and the
 * player cannot see which happened.
 */
export const AssignFactoriesSchema = z.object({
  kind: z.literal("assign_factories"),
  lineId: z.number().int().positive(),
  factories: z.number().int().nonnegative(),
});

/** Raise a division in a province, at the cost of manpower. */
export const RaiseDivisionSchema = z.object({
  kind: z.literal("raise_division"),
  provinceId: z.number().int().nonnegative(),
});

/** Disband one. The manpower is not returned; the equipment is. */
export const DisbandDivisionSchema = z.object({
  kind: z.literal("disband_division"),
  divisionId: z.number().int().positive(),
});

export const CommandBodySchema = z.discriminatedUnion("kind", [
  ClaimProvinceSchema,
  QueueConstructionSchema,
  CancelConstructionSchema,
  CreateProductionLineSchema,
  RemoveProductionLineSchema,
  SwitchProductionLineSchema,
  AssignFactoriesSchema,
  RaiseDivisionSchema,
  DisbandDivisionSchema,
]);
export type CommandBody = z.infer<typeof CommandBodySchema>;

/**
 * `id` is chosen by the client and comes back on the ack. Without it a client
 * that has two commands in flight cannot tell which one was refused, and
 * "something was rejected" is not a message anyone can act on.
 */
export const ClientCommandSchema = z.object({
  t: z.literal("command"),
  id: z.string().min(1).max(64),
  command: CommandBodySchema,
});

export const ClientMessageSchema = z.discriminatedUnion("t", [
  ClientHelloSchema,
  ClientCommandSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientHello = z.infer<typeof ClientHelloSchema>;
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const NationStaticSchema = z.object({
  /** Renderer palette slot. 1-based; 0 means unowned. */
  smallID: z.number().int().positive(),
  name: z.string(),
});
export type NationStatic = z.infer<typeof NationStaticSchema>;

/**
 * Identifies the map both sides must agree on.
 *
 * `partitionHash` is the load-bearing field. The province -> tile mapping is
 * static map data: it is never sent, and both sides load it from the artefact
 * checked in beside the terrain (docs/decisions/0006). Nothing on the wire
 * would otherwise disagree if the client served a stale provinces.bin out of
 * its HTTP cache — the province ids would simply mean different things, and
 * the only symptom would be quietly mis-coloured regions.
 *
 * `terrainHash` is kept beside it because the artefact and the terrain are
 * two files that can also drift apart from each other.
 */
export const MapDescriptorSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  provinceCount: z.number().int().nonnegative(),
  terrainHash: z.number().int().nonnegative(),
  partitionHash: z.number().int().nonnegative(),
});
export type MapDescriptor = z.infer<typeof MapDescriptorSchema>;

export const ServerWelcomeSchema = z.object({
  t: z.literal("welcome"),
  protocolVersion: z.number().int(),
  worldId: z.string(),
});

export const ServerRejectSchema = z.object({
  t: z.literal("reject"),
  reason: z.enum([
    "protocol-version",
    "unknown-world",
    "malformed",
    "unauthorised",
  ]),
  detail: z.string(),
  serverProtocolVersion: z.number().int(),
});

/**
 * A nation's economy, as only that nation sees it.
 *
 * Sent to the session that plays this nation and to nobody else. Stockpiles
 * and construction queues are private; CLAUDE.md §7 makes trust and agreement
 * *terms* the public/private split for diplomacy in phase 7, and an economy is
 * further inside that line than either.
 *
 * Every rate here is per tick, as the simulation computes it. The UI
 * multiplies by TICKS_PER_DAY and labels it per day (invariant 9) — the
 * conversion belongs on the screen, not on the wire, so there is exactly one
 * place it can be got wrong.
 */
export const ResourceAmountsSchema = z.object({
  steel: z.number(),
  oil: z.number(),
  aluminium: z.number(),
  rubber: z.number(),
});
export type ResourceAmounts = z.infer<typeof ResourceAmountsSchema>;

export const ConstructionOrderSchema = z.object({
  /** Stable for the life of the order; what `cancel_construction` names. */
  id: z.number().int().positive(),
  provinceId: z.number().int().nonnegative(),
  building: z.enum(BUILDING_TYPES),
  /** Construction points accrued so far, against the building's cost. */
  progress: z.number(),
});
export type ConstructionOrderView = z.infer<typeof ConstructionOrderSchema>;

export const ProductionLineSchema = z.object({
  id: z.number().int().positive(),
  equipment: z.enum(EQUIPMENT_TYPES),
  factories: z.number().int().nonnegative(),
  /** EFFICIENCY_FLOOR..EFFICIENCY_CAP. The number a switch throws away. */
  efficiency: z.number(),
  /** Equipment per tick at this efficiency and the nation's sufficiency. */
  outputPerTick: z.number(),
});
export type ProductionLineView = z.infer<typeof ProductionLineSchema>;

export const DivisionSchema = z.object({
  id: z.number().int().positive(),
  provinceId: z.number().int().nonnegative(),
  /** 0..1 — held equipment against what a division should hold (§6.3). */
  strength: z.number(),
});
export type DivisionView = z.infer<typeof DivisionSchema>;

export const NationEconomySchema = z.object({
  nation: z.number().int().positive(),
  resources: ResourceAmountsSchema,
  extractionPerTick: ResourceAmountsSchema,
  demandPerTick: ResourceAmountsSchema,
  /** 0..1 — the share of this tick's resource demand the nation could cover. */
  sufficiency: z.number(),
  constructionPerTick: z.number(),
  /** Already scaled by `sufficiency`; this is what the factories actually made. */
  industryPerTick: z.number(),
  queue: z.array(ConstructionOrderSchema),
  /** Equipment held, indexed the same way `EQUIPMENT_TYPES` is. */
  stockpile: z.array(z.number()),
  manpower: z.number(),
  manpowerCap: z.number(),
  productionLines: z.array(ProductionLineSchema),
  divisions: z.array(DivisionSchema),
  /** Factories assigned to a line, against those the nation holds. */
  militaryFactoriesAssigned: z.number().int().nonnegative(),
  militaryFactoriesTotal: z.number().int().nonnegative(),
  dockyardsAssigned: z.number().int().nonnegative(),
  dockyardsTotal: z.number().int().nonnegative(),
});
export type NationEconomyView = z.infer<typeof NationEconomySchema>;

/**
 * Buildings, flat: `province * BUILDING_TYPES.length + type`.
 *
 * The whole array on connect, and only what changed afterwards. Europe is
 * 5,290 small integers — about 11 kB of JSON once, against a per-province
 * object graph that would be several times that and would have to name every
 * building type on every province that has none.
 */
export const BuildingChangeSchema = z.array(
  z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
);

const ProvinceChangeSchema = z.array(
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
);

export const FullStateSchema = z.object({
  t: z.literal("full"),
  tick: z.number().int().nonnegative(),
  map: MapDescriptorSchema,
  nations: z.array(NationStaticSchema),
  /** The nation this session acts for, as the server understood it. */
  nation: z.number().int().positive().nullable(),
  /**
   * Owner per province, indexed by province id. 0 is unowned.
   *
   * Who the province belongs to, which is not who is standing on it. See
   * `controllers`, and docs/decisions/0002.
   */
  owners: z.array(z.number().int().nonnegative()),
  /**
   * Controller per province — who holds it right now.
   *
   * This is what the map is coloured by: a player looking at a front wants to
   * see where the line is, not where the line was a fortnight ago.
   */
  controllers: z.array(z.number().int().nonnegative()),
  /** Building counts for every province, flat. */
  buildings: z.array(z.number().int().nonnegative()),
  /** This session's own economy, or null when watching. */
  economy: NationEconomySchema.nullable(),
});
export type FullState = z.infer<typeof FullStateSchema>;

export const DeltaSchema = z.object({
  t: z.literal("delta"),
  tick: z.number().int().nonnegative(),
  /** [provinceId, newController] pairs. Usually the only list with anything in it. */
  control: ProvinceChangeSchema,
  /** [provinceId, newOwner] pairs. Empty on almost every tick. */
  owner: ProvinceChangeSchema,
  /** [provinceId, buildingIndex, newCount] — what finished this tick. */
  buildings: BuildingChangeSchema,
  /** This session's own economy, recomputed every tick, or null when watching. */
  economy: NationEconomySchema.nullable(),
});
export type Delta = z.infer<typeof DeltaSchema>;

/**
 * The answer to exactly one command, matched by its `id`.
 *
 * Every command gets one, accepted or not. A command that is quietly dropped
 * is the failure mode CLAUDE.md §7 is written against: the player sees nothing
 * happen and has no way to tell a refused order from a lost packet.
 *
 * `tick` on an accepted command is the tick it will take effect on — always
 * the next one, never this one. It is also the tick it was written to the log
 * with, so a replay puts it back in the same place.
 */
export const ServerAckSchema = z.object({
  t: z.literal("ack"),
  id: z.string(),
  accepted: z.boolean(),
  tick: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
export type ServerAck = z.infer<typeof ServerAckSchema>;

export const ServerMessageSchema = z.discriminatedUnion("t", [
  ServerAckSchema,
  ServerWelcomeSchema,
  ServerRejectSchema,
  FullStateSchema,
  DeltaSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function encodeClient(message: ClientMessage): string {
  return JSON.stringify(message);
}

export function encodeServer(message: ServerMessage): string {
  return JSON.stringify(message);
}

/** Throws on anything that is not a valid client message. */
export function decodeClientMessage(raw: string): ClientMessage {
  return ClientMessageSchema.parse(JSON.parse(raw));
}

/** Throws on anything that is not a valid server message. */
export function decodeServerMessage(raw: string): ServerMessage {
  return ServerMessageSchema.parse(JSON.parse(raw));
}
