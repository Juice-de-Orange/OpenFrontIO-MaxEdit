CREATE TABLE "commands" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"tick" integer NOT NULL,
	"seq" integer NOT NULL,
	"nation_id" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"world_id" text NOT NULL,
	"tick" integer NOT NULL,
	"state_hash" bigint NOT NULL,
	"state" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" text PRIMARY KEY NOT NULL,
	"map_id" text NOT NULL,
	"terrain_hash" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commands_world_tick_seq" ON "commands" USING btree ("world_id","tick","seq");--> statement-breakpoint
CREATE INDEX "commands_world_tick" ON "commands" USING btree ("world_id","tick");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_world_tick" ON "snapshots" USING btree ("world_id","tick");