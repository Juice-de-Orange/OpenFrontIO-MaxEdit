/**
 * The durable shape of a world.
 *
 * Five tables, and each of them answers a question the in-memory world
 * cannot: which worlds exist, what did players do, what did the world look
 * like at some point recently — and, since phase 11, who anybody is and
 * which nation they hold.
 *
 * Identity lives beside the world, never in it (decision 0019): accounts and
 * claims are not in the snapshot, not in the state hash, and not on the
 * wire's simulation half. The simulation stays account-free and a replay
 * needs no login history to land on the same world.
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
  /**
   * The province artefact the world was created against.
   *
   * Nullable, and only because worlds created before this column existed do
   * not have one; `ensureWorld` fills it in the first time such a world
   * starts. Every new world writes it immediately.
   *
   * The terrain hash above is not enough on its own. A regenerated artefact
   * over *unchanged terrain* — a fix to the partition, or a tuned number in
   * `shared/config/provinces.ts` — passes the terrain check and then means
   * something different by every province id in the command log. The snapshot
   * check catches it once a snapshot exists; this catches it in the first
   * sixty ticks, before one does, and it is the record of the world's identity
   * rather than an incidental consequence of one.
   */
  partitionHash: bigint("partition_hash", { mode: "number" }),
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

/**
 * Who somebody is: a name and the hash of the token that proves it.
 *
 * Registration is deliberately minimal — this is a hobby world, not a
 * service — but it is a real credential (CLAUDE.md §8, phase 11): the token
 * is generated server-side, returned exactly once, and only its SHA-256 is
 * stored. A database dump leaks no credentials, which is also why this
 * repository's `.gitignore` was so wary of `*.sql`.
 */
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Which account holds which nation, per world, for the life of a season.
 *
 * Both unique indexes are the phase-11 gate's two sentences as constraints:
 * two accounts cannot hold the same nation, and one account holds at most
 * one nation. The claim is made by the first authenticated `hello` naming a
 * free nation — §10's "new players take a nation no account holds" — and
 * nothing short of a season reset releases it.
 */
export const nationClaims = pgTable(
  "nation_claims",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id),
    nationId: integer("nation_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("nation_claims_world_nation").on(table.worldId, table.nationId),
    uniqueIndex("nation_claims_world_account").on(
      table.worldId,
      table.accountId,
    ),
  ],
);
