CREATE TABLE "billing_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"active_plan_id" text NOT NULL,
	"soft_cap_microusd" bigint,
	"hard_cap_microusd" bigint,
	"last_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_billing_accounts_owner_user_id" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "billing_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"period_id" text,
	"entry_type" text NOT NULL,
	"direction" text NOT NULL,
	"amount_microusd" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_billing_ledger_source_entry" UNIQUE("source_type","source_id","entry_type")
);
--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"plan_id_snapshot" text NOT NULL,
	"rate_card_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"included_credit_microusd" bigint DEFAULT 0 NOT NULL,
	"soft_cap_microusd" bigint,
	"hard_cap_microusd" bigint,
	"usage_charge_microusd" bigint DEFAULT 0 NOT NULL,
	"credit_applied_microusd" bigint DEFAULT 0 NOT NULL,
	"reserved_microusd" bigint DEFAULT 0 NOT NULL,
	"balance_microusd" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"external_invoice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_billing_periods_account_start_end" UNIQUE("account_id","period_start","period_end")
);
--> statement-breakpoint
CREATE TABLE "billing_rate_card_items" (
	"id" text PRIMARY KEY NOT NULL,
	"rate_card_id" text NOT NULL,
	"meter_key" text NOT NULL,
	"provider" text,
	"model_pattern" text,
	"price_microusd" bigint NOT NULL,
	"per_unit" bigint NOT NULL,
	"rounding_mode" text DEFAULT 'up' NOT NULL,
	"minimum_charge_microusd" bigint,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_rate_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_billing_rate_cards_name_version" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "billing_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"session_id" text,
	"skill_id" text,
	"source_type" text NOT NULL,
	"meter_key" text NOT NULL,
	"provider" text,
	"model" text,
	"quantity" bigint NOT NULL,
	"unit" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_billing_usage_events_idempotency_key" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_rate_card_id_billing_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."billing_rate_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_rate_card_items" ADD CONSTRAINT "billing_rate_card_items_rate_card_id_billing_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."billing_rate_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_events" ADD CONSTRAINT "billing_usage_events_session_id_agent_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_runtime_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_billing_accounts_status" ON "billing_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_billing_ledger_account_created" ON "billing_ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_billing_ledger_period_id" ON "billing_ledger_entries" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "idx_billing_ledger_entry_type" ON "billing_ledger_entries" USING btree ("entry_type");--> statement-breakpoint
CREATE INDEX "idx_billing_periods_account_status" ON "billing_periods" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "idx_billing_rate_card_items_card_meter" ON "billing_rate_card_items" USING btree ("rate_card_id","meter_key");--> statement-breakpoint
CREATE INDEX "idx_billing_rate_cards_status_effective" ON "billing_rate_cards" USING btree ("status","effective_from");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_events_account_occurred" ON "billing_usage_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_events_agent_occurred" ON "billing_usage_events" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_events_session_id" ON "billing_usage_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_events_meter_occurred" ON "billing_usage_events" USING btree ("meter_key","occurred_at");