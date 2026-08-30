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
export const PROTOCOL_VERSION = 1;

/** WebSocket close codes, in the application-defined range. */
export const CloseCode = {
  ProtocolVersion: 4001,
  Malformed: 4002,
  UnknownWorld: 4003,
  NoHelloTimeout: 4004,
} as const;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientHelloSchema = z.object({
  t: z.literal("hello"),
  protocolVersion: z.number().int(),
  worldId: z.string().min(1),
});

/**
 * Phase 0 has no commands. That is deliberate rather than an omission:
 * CLAUDE.md §7 requires every command to be validated against current world
 * state, and there is no world state to validate against yet. Inventing a
 * command type now means rewriting it in phase 1.
 *
 * The rule it would carry is already in force, though — the server treats any
 * message after `hello` as a protocol violation and closes the connection,
 * rather than ignoring it.
 */
export const ClientMessageSchema = ClientHelloSchema;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

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
 * `terrainHash` is the load-bearing field. The province -> tile mapping is
 * static map data: it is never sent, and both sides derive it from the same
 * terrain bytes. Nothing on the wire would otherwise disagree if one side
 * read map.bin and the other map4x.bin — the province ids would simply mean
 * different things, and the only symptom would be quietly mis-coloured
 * regions.
 */
export const MapDescriptorSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  provinceCount: z.number().int().nonnegative(),
  terrainHash: z.number().int().nonnegative(),
});
export type MapDescriptor = z.infer<typeof MapDescriptorSchema>;

export const ServerWelcomeSchema = z.object({
  t: z.literal("welcome"),
  protocolVersion: z.number().int(),
  worldId: z.string(),
});

export const ServerRejectSchema = z.object({
  t: z.literal("reject"),
  reason: z.enum(["protocol-version", "unknown-world", "malformed"]),
  detail: z.string(),
  serverProtocolVersion: z.number().int(),
});

export const FullStateSchema = z.object({
  t: z.literal("full"),
  tick: z.number().int().nonnegative(),
  map: MapDescriptorSchema,
  nations: z.array(NationStaticSchema),
  /** Owner per province, indexed by province id. 0 is unowned. */
  owners: z.array(z.number().int().nonnegative()),
});
export type FullState = z.infer<typeof FullStateSchema>;

export const DeltaSchema = z.object({
  t: z.literal("delta"),
  tick: z.number().int().nonnegative(),
  /** [provinceId, newOwner] pairs. */
  changes: z.array(
    z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  ),
});
export type Delta = z.infer<typeof DeltaSchema>;

export const ServerMessageSchema = z.discriminatedUnion("t", [
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
