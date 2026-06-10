CREATE TABLE "agent_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"artifact_type" text NOT NULL,
	"content_type" text NOT NULL,
	"summary" text NOT NULL,
	"location" jsonb,
	"metadata" jsonb,
	"retention_class" text DEFAULT 'standard' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"bot_id" text,
	"type" text NOT NULL,
	"direction" text NOT NULL,
	"schema_version" text DEFAULT 'v1' NOT NULL,
	"sequence" integer,
	"trace_id" text,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"error_detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "agent_outbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text,
	"authored_by" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"context_ref" text,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"telegram_message_id" text,
	"telegram_chat_id" text,
	"delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"cpu_pct" integer,
	"memory_bytes" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"skill_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"pause_state" jsonb,
	"tool_policy" jsonb,
	"model_policy" jsonb,
	"telegram_chat_id" text,
	"execution_mode" text,
	"daily_token_budget" integer,
	"daily_loss_limit" numeric(20, 8),
	"max_bots" integer,
	"max_slippage_bps" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_event_id" text NOT NULL,
	"channel" text NOT NULL,
	"destination" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"strategy_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"corpus_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metrics" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"venue" text NOT NULL,
	"balances" jsonb NOT NULL,
	"mark_source" text,
	"snapshot_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"external_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_billing_customers_user_provider" UNIQUE("user_id","provider"),
	CONSTRAINT "uq_billing_customers_provider_external_id" UNIQUE("provider","external_customer_id")
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"external_customer_id" text NOT NULL,
	"external_subscription_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"external_price_or_product_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_billing_subscriptions_provider_external_id" UNIQUE("provider","external_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'processed' NOT NULL,
	"error" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config_data" jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"strategy_preset" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"trading_binding_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"blueprint_id" text,
	"config_snapshot" jsonb,
	"status" text DEFAULT 'stopped' NOT NULL,
	"creator_type" text DEFAULT 'user' NOT NULL,
	"creator_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "capability_grant_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"capability_family" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"venue" text,
	"symbol" text,
	"interval" text,
	"from" timestamp with time zone,
	"to" timestamp with time zone,
	"file_path" text,
	"row_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"context_hash" text NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"intent" text NOT NULL,
	"target_size" numeric NOT NULL,
	"limit_price" numeric,
	"context_hash" text,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"planned_orders" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"venue_ref_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"fee" numeric,
	"fee_currency" text,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"venue" text NOT NULL,
	"type" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"tick_size" numeric NOT NULL,
	"lot_size" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text,
	"actor_id" text,
	"backtest_run_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_decision_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"context_hash" text NOT NULL,
	"context" jsonb NOT NULL,
	"prompt_payload" text NOT NULL,
	"prompt_version" text NOT NULL,
	"raw_response" text,
	"parsed_decision" jsonb,
	"parse_status" text NOT NULL,
	"parse_error" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"execution_plan_id" text,
	"venue_ref_id" text,
	"client_order_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric,
	"status" text DEFAULT 'pending' NOT NULL,
	"filled_quantity" numeric DEFAULT '0' NOT NULL,
	"avg_fill_price" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"mark_source" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"result" text NOT NULL,
	"local_state" jsonb NOT NULL,
	"venue_state" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_corpora" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"venue" text NOT NULL,
	"symbols" text NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_market_events" (
	"id" text PRIMARY KEY NOT NULL,
	"corpus_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"event_type" text NOT NULL,
	"price" numeric NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"required_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"context_requirements" text[] DEFAULT '{}'::text[] NOT NULL,
	"required_guardrails" text[] DEFAULT '{}'::text[] NOT NULL,
	"capability_families" text[] DEFAULT '{}'::text[] NOT NULL,
	"suggested_tick_interval_ms" integer DEFAULT 900000,
	"visibility" text DEFAULT 'private' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[],
	"fork_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"binding_ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"binding_profile" jsonb,
	"source_venue_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"venue" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_data" text NOT NULL,
	"encryption_meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text DEFAULT 'free' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text,
	"plan_id" text DEFAULT 'free' NOT NULL,
	"telegram_chat_id" text,
	"ai_model_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "venue_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"venue" text NOT NULL,
	"label" text NOT NULL,
	"venue_account_ref" text,
	"credential_id" text,
	"venue_profile" jsonb,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD CONSTRAINT "agent_outbound_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions" ADD CONSTRAINT "agent_runtime_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_venue_account_id_venue_accounts_id_fk" FOREIGN KEY ("venue_account_id") REFERENCES "public"."venue_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_trading_binding_id_trading_bindings_id_fk" FOREIGN KEY ("trading_binding_id") REFERENCES "public"."trading_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_blueprint_id_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grant_audit" ADD CONSTRAINT "capability_grant_audit_grant_id_capability_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."capability_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_binding_id_trading_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."trading_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_identities" ADD CONSTRAINT "local_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_corpora" ADD CONSTRAINT "replay_corpora_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_fork_of_skills_id_fk" FOREIGN KEY ("fork_of") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_bindings" ADD CONSTRAINT "trading_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_bindings" ADD CONSTRAINT "trading_bindings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_accounts" ADD CONSTRAINT "venue_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_accounts" ADD CONSTRAINT "venue_accounts_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_agent_id" ON "agent_artifacts" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_session_id" ON "agent_artifacts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_artifact_type" ON "agent_artifacts" USING btree ("artifact_type");--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_created_at" ON "agent_artifacts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_credentials_agent_id" ON "agent_credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_messages_agent_id" ON "agent_messages" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_messages_bot_id" ON "agent_messages" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "idx_agent_messages_correlation_id" ON "agent_messages" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "idx_agent_messages_type" ON "agent_messages" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_agent_messages_actor_id" ON "agent_messages" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_agent_messages_created_at" ON "agent_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_agent_id" ON "agent_outbound_messages" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_authored_by" ON "agent_outbound_messages" USING btree ("authored_by");--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_created_at" ON "agent_outbound_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_outbound_messages_session_id" ON "agent_outbound_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_agent_id" ON "agent_runtime_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_status" ON "agent_runtime_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_runtime_sessions_active_agent" ON "agent_runtime_sessions" USING btree ("agent_id") WHERE "agent_runtime_sessions"."status" NOT IN ('stopped', 'crashed');--> statement-breakpoint
CREATE INDEX "idx_agents_user_id" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_agents_status" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_alert_deliveries_status" ON "alert_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_alert_deliveries_journal_event_id" ON "alert_deliveries" USING btree ("journal_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alert_deliveries_event_channel_dest" ON "alert_deliveries" USING btree ("journal_event_id","channel","destination");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_status" ON "backtest_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_strategy_type" ON "backtest_runs" USING btree ("strategy_type");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_created_at" ON "backtest_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_balance_snapshots_venue_account_id" ON "balance_snapshots" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_balance_snapshots_snapshot_at" ON "balance_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_billing_customers_user_id" ON "billing_customers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_billing_customers_external_id" ON "billing_customers" USING btree ("external_customer_id");--> statement-breakpoint
CREATE INDEX "idx_billing_customers_user_provider" ON "billing_customers" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_billing_subscriptions_user_id" ON "billing_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_billing_subscriptions_external_subscription_id" ON "billing_subscriptions" USING btree ("external_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_billing_subscriptions_status" ON "billing_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_billing_subscriptions_provider" ON "billing_subscriptions" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_billing_webhook_events_event_type" ON "billing_webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_blueprints_user_id" ON "blueprints" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_blueprints_visibility" ON "blueprints" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "idx_bots_user_id" ON "bots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_bots_status" ON "bots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_bots_creator_id" ON "bots" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_bots_venue_account_id" ON "bots" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_bots_trading_binding_id" ON "bots" USING btree ("trading_binding_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grant_audit_grant_id" ON "capability_grant_audit" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grant_audit_created_at" ON "capability_grant_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_capability_grant_audit_actor_id" ON "capability_grant_audit" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grants_agent_id" ON "capability_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grants_binding_id" ON "capability_grants" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "idx_capability_grants_status" ON "capability_grants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_grants_active" ON "capability_grants" USING btree ("agent_id","binding_id","capability_family") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_connections_user_id" ON "connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_connections_provider" ON "connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_connections_status" ON "connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_datasets_user_id" ON "datasets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_datasets_status" ON "datasets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_decision_id" ON "decision_contexts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_context_hash" ON "decision_contexts" USING btree ("context_hash");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_venue_account_id" ON "decision_contexts" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_actor_id" ON "decision_contexts" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_decisions_venue_account_id" ON "decisions" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_decisions_actor_type" ON "decisions" USING btree ("actor_type");--> statement-breakpoint
CREATE INDEX "idx_decisions_actor_id" ON "decisions" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_decisions_created_at" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_decision_id" ON "execution_plans" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_venue_account_id" ON "execution_plans" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_actor_id" ON "execution_plans" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_fills_order_id" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_fills_venue_account_id" ON "fills" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_fills_actor_id" ON "fills" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_fills_filled_at" ON "fills" USING btree ("filled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_instruments_venue_symbol" ON "instruments" USING btree ("venue","symbol");--> statement-breakpoint
CREATE INDEX "idx_journal_events_actor_id" ON "journal_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_journal_events_type" ON "journal_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_journal_events_created_at" ON "journal_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_journal_events_backtest_run_id" ON "journal_events" USING btree ("backtest_run_id");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_decision_id" ON "llm_decision_artifacts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_context_hash" ON "llm_decision_artifacts" USING btree ("context_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_local_identities_user_id" ON "local_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_identities_user_id" ON "oauth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_oauth_identities_provider_user_id" ON "oauth_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE INDEX "idx_orders_venue_account_id" ON "orders" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_orders_actor_id" ON "orders" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_orders_venue_ref_id" ON "orders" USING btree ("venue_ref_id");--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_positions_venue_account_id" ON "positions" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_positions_actor" ON "positions" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_positions_venue_symbol" ON "positions" USING btree ("venue_account_id","symbol");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_venue_account_id" ON "reconciliation_events" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_created_at" ON "reconciliation_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_result" ON "reconciliation_events" USING btree ("result");--> statement-breakpoint
CREATE INDEX "idx_replay_corpora_venue" ON "replay_corpora" USING btree ("venue");--> statement-breakpoint
CREATE INDEX "idx_replay_market_events_corpus_symbol_time" ON "replay_market_events" USING btree ("corpus_id","symbol","event_at");--> statement-breakpoint
CREATE INDEX "idx_replay_market_events_corpus_type" ON "replay_market_events" USING btree ("corpus_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_skills_author_id" ON "skills" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_skills_visibility" ON "skills" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "idx_trading_bindings_user_id" ON "trading_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_trading_bindings_connection_id" ON "trading_bindings" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_trading_bindings_provider" ON "trading_bindings" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "idx_trading_bindings_status" ON "trading_bindings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trading_bindings_connection_id" ON "trading_bindings" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_user_plans_user_id" ON "user_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_venue_accounts_user_id" ON "venue_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_venue_accounts_credential_id" ON "venue_accounts" USING btree ("credential_id");