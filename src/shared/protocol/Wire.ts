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
import { AGREEMENT_TYPES } from "../config/diplomacy";
import { RESOURCES } from "../config/provinces";
import { REGENT_FOCI } from "../config/regent";
import { TECH_IDS } from "../config/techs";
import { BUILDING_TYPES } from "../economy/Buildings";
import { EQUIPMENT_TYPES } from "../economy/Equipment";
import {
  FORMATION_TEMPLATES,
  MISSIONS,
  ZONE_KINDS,
} from "../economy/Formations";

/**
 * Bumped whenever a message shape changes in a way an older peer would
 * misread. One integer, not a semver range: the only question is whether the
 * two sides agree.
 */
export const PROTOCOL_VERSION = 15;

/** WebSocket close codes, in the application-defined range. */
export const CloseCode = {
  ProtocolVersion: 4001,
  Malformed: 4002,
  UnknownWorld: 4003,
  NoHelloTimeout: 4004,
  Unauthorised: 4005,
  /**
   * A newer connection from the same account took this session over.
   * Terminal on purpose: two browsers auto-reconnecting would otherwise
   * kick each other for ever.
   */
  Superseded: 4006,
} as const;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientHelloSchema = z.object({
  t: z.literal("hello"),
  protocolVersion: z.number().int(),
  worldId: z.string().min(1),
  /** Which nation this session acts for, or null to watch. */
  nation: z.number().int().positive().nullable(),
  /**
   * The account token from `POST /register`, or null.
   *
   * Phase 11: on a season world (`WORLD_SEASON=open`) playing a nation
   * requires it — the token names an account, the account holds exactly one
   * nation for the life of the season, and an impostor is refused before it
   * is sent anything (decision 0019). Watching stays open, like /health. On
   * a workbench world the field is carried and ignored, so every gate and
   * local loop keeps working without a login step.
   */
  token: z.string().min(1).nullable(),
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
/**
 * Call off an attack that is still grinding.
 *
 * The other half of `claim_province` now that an attack is a standing order
 * (§6.9): a front that cannot be called off is a front a player is stuck with,
 * and the equipment goes on being spent for as long as it stands.
 */
export const CancelAttackSchema = z.object({
  kind: z.literal("cancel_attack"),
  provinceId: z.number().int().nonnegative(),
});

/**
 * Put a division to sea, aimed at a hostile shore (§6.8).
 *
 * As always, note what is *not* here: no path, no duration, no landing
 * strength. The server finds the sea route, prices the crossing in ticks and
 * announces the transit to everyone — the visibility is the defence.
 */
export const NavalInvadeSchema = z.object({
  kind: z.literal("naval_invade"),
  divisionId: z.number().int().positive(),
  provinceId: z.number().int().nonnegative(),
});

/**
 * Set how the world plays this nation when nobody is (§6.10).
 *
 * The whole config at once, absolute — the same reason `assign_factories`
 * is: a partial update applied twice means something different from once.
 */
export const ConfigureRegentSchema = z.object({
  kind: z.literal("configure_regent"),
  enabled: z.boolean(),
  focus: z.enum(REGENT_FOCI),
  marketBudget: z.number().nonnegative(),
});

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

/** Raise a wing or a fleet at a base, at the cost of manpower (§6.7). */
export const RaiseFormationSchema = z.object({
  kind: z.literal("raise_formation"),
  template: z.enum(FORMATION_TEMPLATES),
  provinceId: z.number().int().nonnegative(),
});

/** Disband one. Same terms as a division. */
export const DisbandFormationSchema = z.object({
  kind: z.literal("disband_formation"),
  formationId: z.number().int().positive(),
});

/**
 * Send a formation to a zone with a mission, or bring it home.
 *
 * Absolute, for the same reason `assign_factories` is: a delta applied twice
 * means something different from one applied once and the player cannot see
 * which happened. `zone` and `mission` are null together — that is the
 * formation standing down at its base, where it costs and contributes
 * nothing.
 */
export const AssignFormationSchema = z.object({
  kind: z.literal("assign_formation"),
  formationId: z.number().int().positive(),
  zone: z.number().int().nonnegative().nullable(),
  mission: z.enum(MISSIONS).nullable(),
});

/**
 * Put a slot to work on a tech.
 *
 * By slot index and tech id, both absolute. The server checks that the slot
 * exists, that the nation has unlocked it, that the tech's prerequisites are
 * in hand and that it is not already known — §7, the client computes none of
 * it.
 */
export const StartResearchSchema = z.object({
  kind: z.literal("start_research"),
  slot: z.number().int().nonnegative(),
  tech: z.enum(TECH_IDS),
});

/** Take a slot off what it is doing. The hours already put in are lost. */
export const CancelResearchSchema = z.object({
  kind: z.literal("cancel_research"),
  slot: z.number().int().nonnegative(),
});

/**
 * The terms of a trade agreement, as one side proposes them.
 *
 * Both sides see the exact rates before accepting (§6.5), which is why they
 * are on the wire in full rather than being summarised. Per tick, because
 * everything in this world is a rate — the UI multiplies by 24 and says "per
 * day" (invariant 9), and the wire never does.
 */
export const TradeTermsSchema = z.object({
  /** What the proposer sends. */
  resource: z.enum(RESOURCES),
  /**
   * Shape here, **limits in the world**.
   *
   * A rate of zero, or one past `MAX_TRADE_RESOURCE_PER_TICK`, used to be a
   * schema failure — and a schema failure is a protocol violation, which
   * closes the socket with `CloseCode.Malformed` and stops the client
   * reconnecting. A player who offered a trade without filling both fields
   * was thrown out of a running world for pressing a button the UI gave them.
   *
   * A number the world will not accept is a game rule, and this project
   * answers game rules with an ack and a reason (§7). So the boundary checks
   * that this is a finite number and `World.rejectionFor` checks that it is a
   * *sensible* one.
   */
  resourcePerTick: z.number().finite(),
  /** Construction points the other side sends back. No second currency. */
  pointsPerTick: z.number().finite(),
});
export type TradeTermsView = z.infer<typeof TradeTermsSchema>;

/**
 * Offer an agreement to another nation.
 *
 * **No duration, and there is nowhere to put one** (invariant 3). An
 * agreement runs until somebody cancels it and pays for having done so. The
 * only thing this carries beyond who and what is the terms, and only a trade
 * agreement has any.
 */
export const ProposeAgreementSchema = z.object({
  kind: z.literal("propose_agreement"),
  to: z.number().int().positive(),
  type: z.enum(AGREEMENT_TYPES),
  terms: TradeTermsSchema.nullable().optional(),
});

/** Accept an offer made to you. Only the other party may. */
export const AcceptAgreementSchema = z.object({
  kind: z.literal("accept_agreement"),
  agreementId: z.number().int().positive(),
});

/** Turn one down, or take back one you made. Neither costs anything. */
export const DeclineAgreementSchema = z.object({
  kind: z.literal("decline_agreement"),
  agreementId: z.number().int().positive(),
});

/**
 * Give notice on a standing agreement.
 *
 * Costs trust the moment it is sent, and the flow stops one in-game day
 * later. The other side hears about it immediately — that is what the day is
 * for, and it is the only duration in §6.5.
 */
export const CancelAgreementSchema = z.object({
  kind: z.literal("cancel_agreement"),
  agreementId: z.number().int().positive(),
});

/**
 * Leave a standing order with the world market.
 *
 * Positive buys the resource and costs construction points; negative sells it
 * and earns far fewer. Zero clears the order. No counterparty, no agreement,
 * no obligation — which is what keeps it inside invariant 7 and makes it
 * something the regent may use (§6.10).
 */
export const SetMarketOrderSchema = z.object({
  kind: z.literal("set_market_order"),
  resource: z.enum(RESOURCES),
  /** Shape here, limits in the world — the same reasoning as `TradeTerms`. */
  perTick: z.number().finite(),
});

/**
 * "Somebody is playing this nation."
 *
 * Sent by the server's own socket layer when a session connects and every so
 * often while it stays, and written to the command log like any other command.
 * That is deliberate: §6.5's dead-partner rule dissolves the agreements of a
 * nation nobody has played for a fortnight, and §4 requires that agreements be
 * reconstructible from the log alone. A connection is not in the log; a
 * command is.
 */
export const NationPresentSchema = z.object({
  kind: z.literal("nation_present"),
});

export const CommandBodySchema = z.discriminatedUnion("kind", [
  ClaimProvinceSchema,
  CancelAttackSchema,
  NavalInvadeSchema,
  ConfigureRegentSchema,
  QueueConstructionSchema,
  CancelConstructionSchema,
  CreateProductionLineSchema,
  RemoveProductionLineSchema,
  SwitchProductionLineSchema,
  AssignFactoriesSchema,
  RaiseDivisionSchema,
  DisbandDivisionSchema,
  RaiseFormationSchema,
  DisbandFormationSchema,
  AssignFormationSchema,
  StartResearchSchema,
  CancelResearchSchema,
  ProposeAgreementSchema,
  AcceptAgreementSchema,
  DeclineAgreementSchema,
  CancelAgreementSchema,
  SetMarketOrderSchema,
  NationPresentSchema,
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
  /** -1 while the division is at sea (§6.8); a province id otherwise. */
  provinceId: z.number().int().gte(-1),
  /** 0..1 — held equipment against what a division should hold (§6.3). */
  strength: z.number(),
  /**
   * 0..1 — how much of what it needs is actually reaching it (§6.6).
   *
   * Separate from `strength` rather than folded into it, because they are two
   * different problems with two different answers: a weak division needs
   * equipment out of the stockpile, an unsupplied one needs a hub or a shorter
   * front. A single number would tell the player something is wrong and
   * nothing about which.
   */
  supply: z.number(),
});
export type DivisionView = z.infer<typeof DivisionSchema>;

export const FormationSchema = z.object({
  id: z.number().int().positive(),
  template: z.enum(FORMATION_TEMPLATES),
  /** The province whose base it flies out of. */
  baseProvinceId: z.number().int().nonnegative(),
  /** The zone it is assigned to, or null when it is standing down. */
  zone: z.number().int().nonnegative().nullable(),
  mission: z.enum(MISSIONS).nullable(),
  /** 0..1 — held equipment against what the template asks for. */
  strength: z.number(),
});
export type FormationView = z.infer<typeof FormationSchema>;

/**
 * What a nation can see of one zone: who is winning the sky over it.
 *
 * Only zones this nation has something to do with — one it holds ground in,
 * or one it has sent a formation to. Superiority is public in the sense that
 * both sides of a contested zone can see their own share of it; what the
 * other side has *assigned* is not on the wire, because that is the same
 * intelligence a player would have to fly a mission to learn.
 */
export const ZoneSchema = z.object({
  zone: z.number().int().nonnegative(),
  kind: z.enum(ZONE_KINDS),
  /** 0..1 — this nation's share of the air over the zone. 0.5 is a stalemate. */
  superiority: z.number(),
  /** Whether anybody else has anything there at all. */
  contested: z.boolean(),
  /** This nation's own strength in the zone, summed over its formations. */
  ownStrength: z.number(),
});
export type ZoneView = z.infer<typeof ZoneSchema>;

export const ResearchSlotSchema = z.object({
  /** What this slot is working on, or null when it is idle. */
  tech: z.enum(TECH_IDS).nullable(),
  /** Ticks of work done. The UI divides by the tech's own duration. */
  progress: z.number(),
  /** False for a slot the nation has not unlocked yet (§6.4: 2 of up to 4). */
  unlocked: z.boolean(),
});
export type ResearchSlotView = z.infer<typeof ResearchSlotSchema>;

export const NationEconomySchema = z.object({
  nation: z.number().int().positive(),
  resources: ResourceAmountsSchema,
  extractionPerTick: ResourceAmountsSchema,
  demandPerTick: ResourceAmountsSchema,
  /** 0..1 — the share of this tick's resource demand the nation could cover. */
  sufficiency: z.number(),
  constructionPerTick: z.number(),
  /**
   * Construction points arriving from, and leaving for, trade partners and
   * the market — already scaled by what both sides could actually cover.
   *
   * On the economy screen because that is where the price of an import has
   * to be visible: points spent here are factories not built (§6.5), and a
   * player whose queue slowed down deserves to see why without opening
   * another panel.
   */
  tradePointsIn: z.number(),
  tradePointsOut: z.number(),
  /** Net resources per tick from every standing agreement and market order. */
  tradeResourcePerTick: ResourceAmountsSchema,
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
  researchSlots: z.array(ResearchSlotSchema),
  /** Techs this nation has finished. Order is not significant. */
  unlockedTechs: z.array(z.enum(TECH_IDS)),
  /**
   * Provinces this nation is attacking, in the order the orders were given.
   *
   * An attack is a standing order since §6.9 became real (decision 0014): it
   * grinds every tick until the province falls or the player calls it off. A
   * player who cannot see what they have ordered cannot call it off, and the
   * equipment goes on being spent — so the list is on the wire and the HUD
   * puts a button next to each one.
   */
  attacks: z.array(
    z.object({
      province: z.number().int().nonnegative(),
      /** How far the front has ground in, 0..1 (invariant 1: a rate). */
      progress: z.number().min(0).max(1),
    }),
  ),
  /** How the world plays this nation when nobody is (§6.10). Own eyes only. */
  regent: z.object({
    enabled: z.boolean(),
    focus: z.enum(REGENT_FOCI),
    marketBudget: z.number().nonnegative(),
  }),
  /** This nation's own divisions at sea, with the whole crossing visible. */
  seaTransits: z.array(
    z.object({
      id: z.number().int().positive(),
      divisionId: z.number().int().positive(),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      ticksLeft: z.number().int().nonnegative(),
    }),
  ),
  /** Wings and fleets this nation has raised, wherever they are (§6.7). */
  formations: z.array(FormationSchema),
  /** The zones it can see something in, and how the air over them stands. */
  zones: z.array(ZoneSchema),
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

/**
 * One agreement or proposal, as this session is allowed to see it.
 *
 * §7 draws the line here and the server draws it before sending: **trust is
 * public, terms are not.** Everyone can see that two nations have a trade
 * agreement — that is what makes the diplomatic map readable — and only the
 * two of them can see what it moves. `terms` comes back null on somebody
 * else's agreement, and on every agreement that is not a trade.
 */
export const AgreementViewSchema = z.object({
  id: z.number().int().positive(),
  type: z.enum(AGREEMENT_TYPES),
  /** Proposer first. For a trade, the first party sends the resource. */
  parties: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  terms: TradeTermsSchema.nullable(),
  /** False while it is still an offer nobody has answered. */
  accepted: z.boolean(),
  /** The tick somebody gave notice, or null. Not an expiry — see §6.5. */
  noticeAt: z.number().int().nonnegative().nullable(),
  noticeBy: z.number().int().positive().nullable(),
});
export type AgreementView = z.infer<typeof AgreementViewSchema>;

/**
 * One standing attack, as anyone may see it.
 *
 * Public the way `controllers` is public: a front is visible to anyone
 * looking at the map. The defender watches themselves being ground down, a
 * third party sees a war next door, and every client — spectators included —
 * paints partial progress as tiles, which it cannot do for a front it is not
 * told about.
 */
export const FrontViewSchema = z.object({
  province: z.number().int().nonnegative(),
  attacker: z.number().int().positive(),
  /** 0..1; the province changes hands when it completes (invariant 1). */
  progress: z.number().min(0).max(1),
});
export type FrontView = z.infer<typeof FrontViewSchema>;

/**
 * One division at sea, as anyone may see it (§6.8: "the units are visible
 * and vulnerable in transit"). The visibility is what makes the crossing
 * answerable: a defender who sees it coming has the whole transit to put a
 * garrison on the beach, and a garrisoned beach turns the landing back.
 */
export const InvasionViewSchema = z.object({
  attacker: z.number().int().positive(),
  to: z.number().int().nonnegative(),
  ticksLeft: z.number().int().nonnegative(),
});
export type InvasionView = z.infer<typeof InvasionViewSchema>;

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
  /**
   * Every nation's trust, indexed by nation id. Index 0 is unused.
   *
   * Public to everybody (§7), and deliberately so: a nation that has broken
   * its word is supposed to be visibly harder to deal with, and that only
   * works if the number is on everyone's screen.
   */
  trust: z.array(z.number()),
  /** Agreements and proposals this session may see. */
  agreements: z.array(AgreementViewSchema),
  /** Every standing attack in the world, in full. Small, like agreements. */
  fronts: z.array(FrontViewSchema),
  /** Every division at sea, §6.8: the crossing is visible to everyone. */
  invasions: z.array(InvasionViewSchema),
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
  /** Every nation's trust, as in the full state. */
  trust: z.array(z.number()),
  /**
   * Agreements and proposals this session may see, in full, every tick.
   *
   * Not a change list. There are a few dozen of these in a world and a
   * proposal arriving is the one piece of diplomacy that must never be
   * missed — a diff of a list this small would be more code to get wrong
   * than it could ever save.
   */
  agreements: z.array(AgreementViewSchema),
  /**
   * Every standing attack, in full, every tick — not a change list, for the
   * same reason `agreements` is not: there are a handful of these in a world,
   * and a front whose progress update was missed is a map lying about where
   * the line is.
   */
  fronts: z.array(FrontViewSchema),
  /** Every division at sea, in full every tick, as on the full state. */
  invasions: z.array(InvasionViewSchema),
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
