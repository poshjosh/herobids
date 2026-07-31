CREATE TABLE "decision_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"short_code" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"actor_type" text DEFAULT 'agent' NOT NULL,
	"actor_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"authorization_mode_snapshot" text NOT NULL,
	"status" text NOT NULL,
	"execution_status" text,
	"instrument_id" text NOT NULL,
	"intent" text NOT NULL,
	"target_size" numeric NOT NULL,
	"limit_price" numeric,
	"stop_loss" numeric,
	"take_profit" numeric,
	"confidence" numeric,
	"rationale_summary" text NOT NULL,
	"context_hash" text,
	"proposed_payload" jsonb NOT NULL,
	"decision_id" text,
	"plan_id" text,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_source" text,
	"last_resolution_attempt_at" timestamp with time zone,
	"last_resolution_error_code" text,
	"last_resolution_error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_decision_approvals_user_status_created_at" ON "decision_approvals" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_decision_approvals_agent_status_created_at" ON "decision_approvals" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_decision_approvals_user_short_code" ON "decision_approvals" USING btree ("user_id","short_code");