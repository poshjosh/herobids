CREATE TABLE "market_assessment_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"billing_period_id" text,
	"rate_card_id" text,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"identity_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"attempt_number" integer DEFAULT 0 NOT NULL,
	"request_group_key" text NOT NULL,
	"status" text NOT NULL,
	"billing_outcome" text,
	"reservation_amount_microusd" bigint,
	"reservation_ledger_entry_id" text,
	"capture_usage_event_id" text,
	"capture_ledger_entry_id" text,
	"release_ledger_entry_id" text,
	"assessment_run_id" text,
	"assessment_artifact_id" text,
	"estimated_llm_cost_microusd" bigint,
	"llm_input_tokens" bigint,
	"llm_output_tokens" bigint,
	"llm_reasoning_tokens" bigint,
	"llm_call_count" integer,
	"failure_code" text,
	"failure_message" text,
	"requested_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_market_assessment_requests_orderbook_perp" CHECK (
    ("market_assessment_requests"."instrument_kind" IN ('orderbook', 'perp') AND "market_assessment_requests"."symbol" IS NOT NULL AND "market_assessment_requests"."network" IS NULL AND "market_assessment_requests"."address" IS NULL)
    OR "market_assessment_requests"."instrument_kind" NOT IN ('orderbook', 'perp')
  ),
	CONSTRAINT "chk_market_assessment_requests_swap_dex" CHECK (
    ("market_assessment_requests"."instrument_kind" IN ('swap', 'dex') AND "market_assessment_requests"."network" IS NOT NULL AND "market_assessment_requests"."address" IS NOT NULL AND "market_assessment_requests"."symbol" IS NULL)
    OR "market_assessment_requests"."instrument_kind" NOT IN ('swap', 'dex')
  )
);
--> statement-breakpoint
DROP TABLE "market_assessment_wake_decisions" CASCADE;--> statement-breakpoint
ALTER TABLE "market_assessment_requests" ADD CONSTRAINT "market_assessment_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_requests" ADD CONSTRAINT "market_assessment_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_requests" ADD CONSTRAINT "market_assessment_requests_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_requests" ADD CONSTRAINT "market_assessment_requests_billing_period_id_billing_periods_id_fk" FOREIGN KEY ("billing_period_id") REFERENCES "public"."billing_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_requests" ADD CONSTRAINT "market_assessment_requests_assessment_run_id_market_assessment_runs_id_fk" FOREIGN KEY ("assessment_run_id") REFERENCES "public"."market_assessment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_requests" ADD CONSTRAINT "market_assessment_requests_assessment_artifact_id_market_assessment_artifacts_id_fk" FOREIGN KEY ("assessment_artifact_id") REFERENCES "public"."market_assessment_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_market_assessment_requests_identity_lookup" ON "market_assessment_requests" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_requests_agent_requested" ON "market_assessment_requests" USING btree ("agent_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_requests_group_attempt" ON "market_assessment_requests" USING btree ("request_group_key","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_requests_group_in_progress" ON "market_assessment_requests" USING btree ("request_group_key") WHERE "market_assessment_requests"."status" = 'in_progress';