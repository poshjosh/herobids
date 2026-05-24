CREATE TABLE "reconciliation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_instance_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"result" text NOT NULL,
	"local_state" jsonb NOT NULL,
	"venue_state" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venue_accounts" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_trading_instance_id" ON "reconciliation_events" USING btree ("trading_instance_id");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_venue_account_id" ON "reconciliation_events" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_created_at" ON "reconciliation_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_result" ON "reconciliation_events" USING btree ("result");