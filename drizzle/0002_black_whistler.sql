CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "nation_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"nation_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nation_claims" ADD CONSTRAINT "nation_claims_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nation_claims" ADD CONSTRAINT "nation_claims_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nation_claims_world_nation" ON "nation_claims" USING btree ("world_id","nation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nation_claims_world_account" ON "nation_claims" USING btree ("world_id","account_id");