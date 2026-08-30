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

/**
 * Bumped whenever a message shape changes in a way an older peer would
 * misread. One integer, not a semver range: the only question is whether the
 * two sides agree.
 */
export const PROTOCOL_VERSION = 3;

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

export const CommandBodySchema = z.discriminatedUnion("kind", [
  ClaimProvinceSchema,
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
});
export type FullState = z.infer<typeof FullStateSchema>;

export const DeltaSchema = z.object({
  t: z.literal("delta"),
  tick: z.number().int().nonnegative(),
  /** [provinceId, newController] pairs. Usually the only list with anything in it. */
  control: ProvinceChangeSchema,
  /** [provinceId, newOwner] pairs. Empty on almost every tick. */
  owner: ProvinceChangeSchema,
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
