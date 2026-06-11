CREATE TABLE "token_safety_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text,
	"venue_account_id" text NOT NULL,
	"network" text NOT NULL,
	"token_address" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"decision_id" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_token_safety_overrides_actor" ON "token_safety_overrides" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_token_safety_overrides_token" ON "token_safety_overrides" USING btree ("network","token_address");--> statement-breakpoint
CREATE INDEX "idx_token_safety_overrides_status" ON "token_safety_overrides" USING btree ("status");