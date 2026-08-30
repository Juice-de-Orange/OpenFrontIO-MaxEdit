/**
 * The durable shape of a world.
 *
 * Three tables, and each of them answers a question the in-memory world
 * cannot: which worlds exist, what did players do, and what did the world look
 * like at some point recently.
 *
 * Nothing derived is stored. The province partition, the nation list and the
 * map itself are computed from the map files both server and client already
 * hold; putting a second copy in the database would only create something that
 * could disagree with the first.
 */

import {
  bigint,
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `bytea`, which drizzle's pg-core does not ship.
 *
 * The snapshot is gzipped JSON. It could be a jsonb column, and then Postgres
 * would parse and re-serialise a few hundred kilobytes on every read and write
 * for no benefit — nothing ever queries inside a snapshot. Bytes in, bytes
 * out.
 */
const bytea = customType<{ data: Buffer; notNull: true }>({
  dataType: () => "bytea",
});

export const worlds = pgTable("worlds", {
  id: text("id").primaryKey(),
  mapId: text("map_id").notNull(),
  /**
   * The terrain hash the world was created against.
   *
   * Checked on every start. A world whose map file changed underneath it would
   * have a different partition, and its province ids would silently mean
   * different places — the one failure that produces a plausible-looking wrong
   * world rather than an error.
   */
  terrainHash: bigint("terrain_hash", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const commands = pgTable(
  "commands",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id),
    /** The tick this command takes effect on — never the tick it arrived on. */
    tick: integer("tick").notNull(),
    /** Its position within that tick. Two commands on one tick have an order. */
    seq: integer("seq").notNull(),
    nationId: integer("nation_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Append-only, and replayed in this order. The primary key would almost
    // serve — insertion order and acceptance order are the same thing until a
    // write is retried, and "almost" is not a property a season can rest on.
    uniqueIndex("commands_world_tick_seq").on(
      table.worldId,
      table.tick,
      table.seq,
    ),
    index("commands_world_tick").on(table.worldId, table.tick),
  ],
);

export const snapshots = pgTable(
  "snapshots",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id),
    tick: integer("tick").notNull(),
    /** World.stateHash() as it was taken. A snapshot that does not hash to
     * this is damaged, and is refused rather than loaded. */
    stateHash: bigint("state_hash", { mode: "number" }).notNull(),
    /** gzipped JSON of WorldSnapshot. */
    state: bytea("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("snapshots_world_tick").on(table.worldId, table.tick),
  ],
);
