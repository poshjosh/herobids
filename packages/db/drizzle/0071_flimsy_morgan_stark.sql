CREATE TABLE "trading_profile_reconciliation_outbox" (
  "id" text PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL,
  "local_mutation_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "state" text NOT NULL,
  "actions" jsonb NOT NULL,
  "last_error" text,
  "claim_token" text,
  "claim_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trading_profile_reconciliation_outbox_operation" ON "trading_profile_reconciliation_outbox" USING btree ("operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trading_profile_reconciliation_outbox_local_mutation" ON "trading_profile_reconciliation_outbox" USING btree ("local_mutation_id");
--> statement-breakpoint
CREATE INDEX "idx_trading_profile_reconciliation_outbox_recovery" ON "trading_profile_reconciliation_outbox" USING btree ("state", "claim_expires_at", "updated_at");