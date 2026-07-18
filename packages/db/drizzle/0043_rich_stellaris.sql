CREATE TABLE "agent_preset_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"old_preset_key" text NOT NULL,
	"old_preset_behavior_version" text NOT NULL,
	"new_preset_key" text NOT NULL,
	"new_preset_behavior_version" text NOT NULL,
	"assessment_artifact_id" text,
	"identity_snapshot" jsonb NOT NULL,
	"instrument_kind" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"transition_mode" text NOT NULL,
	"open_position_count" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"applied_at" timestamp with time zone NOT NULL,
	"regime_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_scan_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"preset_key" text NOT NULL,
	"preset_behavior_version" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"scan_scope" jsonb,
	"scanned_at" timestamp with time zone NOT NULL,
	"candidates_discovered" integer DEFAULT 0 NOT NULL,
	"candidates_scored" integer DEFAULT 0 NOT NULL,
	"signals_generated" integer DEFAULT 0 NOT NULL,
	"scan_health" text NOT NULL,
	"top_confidence" numeric,
	"regime_bucket" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_assessment_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"identity_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assessment_run_id" text NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_actor_use_age" text NOT NULL,
	"max_wake_age" text NOT NULL,
	"assessment_version" integer DEFAULT 1 NOT NULL,
	"artifact_version" integer DEFAULT 1 NOT NULL,
	"ranking_policy_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allowed_presets" jsonb NOT NULL,
	"current_market_summary" text DEFAULT '' NOT NULL,
	"regime_summary" text DEFAULT '' NOT NULL,
	"scan_health_summary" text DEFAULT '' NOT NULL,
	"preset_rankings" jsonb NOT NULL,
	"recommended_preset" text,
	"relative_uplift" numeric,
	"confidence" numeric NOT NULL,
	"urgency" text DEFAULT 'low' NOT NULL,
	"reasoning_summary" text DEFAULT '' NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_market_assessment_artifacts_orderbook_perp" CHECK (
    ("market_assessment_artifacts"."instrument_kind" IN ('orderbook', 'perp') AND "market_assessment_artifacts"."symbol" IS NOT NULL AND "market_assessment_artifacts"."network" IS NULL AND "market_assessment_artifacts"."address" IS NULL)
    OR "market_assessment_artifacts"."instrument_kind" NOT IN ('orderbook', 'perp')
  ),
	CONSTRAINT "chk_market_assessment_artifacts_swap_dex" CHECK (
    ("market_assessment_artifacts"."instrument_kind" IN ('swap', 'dex') AND "market_assessment_artifacts"."network" IS NOT NULL AND "market_assessment_artifacts"."address" IS NOT NULL AND "market_assessment_artifacts"."symbol" IS NULL)
    OR "market_assessment_artifacts"."instrument_kind" NOT IN ('swap', 'dex')
  )
);
--> statement-breakpoint
CREATE TABLE "market_assessment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"identity_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"error_message" text,
	"assessment_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_market_assessment_runs_orderbook_perp" CHECK (
    ("market_assessment_runs"."instrument_kind" IN ('orderbook', 'perp') AND "market_assessment_runs"."symbol" IS NOT NULL AND "market_assessment_runs"."network" IS NULL AND "market_assessment_runs"."address" IS NULL)
    OR "market_assessment_runs"."instrument_kind" NOT IN ('orderbook', 'perp')
  ),
	CONSTRAINT "chk_market_assessment_runs_swap_dex" CHECK (
    ("market_assessment_runs"."instrument_kind" IN ('swap', 'dex') AND "market_assessment_runs"."network" IS NOT NULL AND "market_assessment_runs"."address" IS NOT NULL AND "market_assessment_runs"."symbol" IS NULL)
    OR "market_assessment_runs"."instrument_kind" NOT IN ('swap', 'dex')
  )
);
--> statement-breakpoint
CREATE TABLE "market_assessment_wake_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"assessment_artifact_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"segment_key" jsonb NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"universe_scope_hash" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decision" text NOT NULL,
	"suppression_reason" text,
	"score_uplift" numeric,
	"confidence" numeric NOT NULL,
	"agent_current_preset" text NOT NULL,
	"recommended_preset" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_advice" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"identity_snapshot" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"review_due_at" timestamp with time zone NOT NULL,
	"next_eligible_at" timestamp with time zone NOT NULL,
	"candidate_rank" integer,
	"supporting_facts" jsonb,
	"active_preset" text NOT NULL,
	"preset_behavior_version" text NOT NULL,
	"outcome" text DEFAULT 'not_advised' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_orderbook_perp_identity" CHECK (
    (instrument_kind IN ('orderbook', 'perp') AND symbol IS NOT NULL AND network IS NULL AND address IS NULL)
    OR instrument_kind NOT IN ('orderbook', 'perp')
  ),
	CONSTRAINT "chk_swap_dex_identity" CHECK (
    (instrument_kind IN ('swap', 'dex') AND network IS NOT NULL AND address IS NOT NULL AND symbol IS NULL)
    OR instrument_kind NOT IN ('swap', 'dex')
  )
);
--> statement-breakpoint
ALTER TABLE "agent_preset_transitions" ADD CONSTRAINT "agent_preset_transitions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preset_transitions" ADD CONSTRAINT "agent_preset_transitions_assessment_artifact_id_market_assessment_artifacts_id_fk" FOREIGN KEY ("assessment_artifact_id") REFERENCES "public"."market_assessment_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" ADD CONSTRAINT "market_assessment_artifacts_assessment_run_id_market_assessment_runs_id_fk" FOREIGN KEY ("assessment_run_id") REFERENCES "public"."market_assessment_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_wake_decisions" ADD CONSTRAINT "market_assessment_wake_decisions_assessment_artifact_id_market_assessment_artifacts_id_fk" FOREIGN KEY ("assessment_artifact_id") REFERENCES "public"."market_assessment_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_wake_decisions" ADD CONSTRAINT "market_assessment_wake_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_advice" ADD CONSTRAINT "review_advice_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_preset_transitions_agent_id" ON "agent_preset_transitions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_preset_transitions_applied_at" ON "agent_preset_transitions" USING btree ("applied_at");--> statement-breakpoint
CREATE INDEX "idx_agent_preset_transitions_outcome" ON "agent_preset_transitions" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "idx_agent_preset_transitions_artifact_id" ON "agent_preset_transitions" USING btree ("assessment_artifact_id");--> statement-breakpoint
CREATE INDEX "idx_agent_preset_transitions_identity_lookup" ON "agent_preset_transitions" USING btree ("instrument_kind","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_agent_id" ON "agent_scan_metrics" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_preset_key" ON "agent_scan_metrics" USING btree ("preset_key");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_scanned_at" ON "agent_scan_metrics" USING btree ("scanned_at");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_scan_scope" ON "agent_scan_metrics" USING btree ("venue_family","style_tier");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_preset_scanned_at" ON "agent_scan_metrics" USING btree ("preset_key","scanned_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_assessment_run_id" ON "market_assessment_artifacts" USING btree ("assessment_run_id");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_expires_at" ON "market_assessment_artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_assessed_at" ON "market_assessment_artifacts" USING btree ("assessed_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_identity_lookup" ON "market_assessment_artifacts" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_artifacts_orderbook_active" ON "market_assessment_artifacts" USING btree ("instrument_kind","venue_family","style_tier","symbol") WHERE "market_assessment_artifacts"."status" = 'active' AND "market_assessment_artifacts"."instrument_kind" IN ('orderbook', 'perp');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_artifacts_swap_active" ON "market_assessment_artifacts" USING btree ("instrument_kind","venue_family","style_tier","network","address") WHERE "market_assessment_artifacts"."status" = 'active' AND "market_assessment_artifacts"."instrument_kind" IN ('swap', 'dex');--> statement-breakpoint
CREATE INDEX "idx_market_assessment_runs_status" ON "market_assessment_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_runs_started_at" ON "market_assessment_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_runs_identity_lookup" ON "market_assessment_runs" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_wake_decisions_agent_id" ON "market_assessment_wake_decisions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_wake_decisions_artifact_id" ON "market_assessment_wake_decisions" USING btree ("assessment_artifact_id");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_wake_decisions_decision" ON "market_assessment_wake_decisions" USING btree ("decision");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_wake_decisions_decided_at" ON "market_assessment_wake_decisions" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_wake_decisions_segment_components" ON "market_assessment_wake_decisions" USING btree ("venue_family","style_tier","universe_scope_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_wake_decisions_agent_artifact" ON "market_assessment_wake_decisions" USING btree ("agent_id","assessment_artifact_id");--> statement-breakpoint
CREATE INDEX "idx_review_advice_agent_id" ON "review_advice" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_review_advice_outcome" ON "review_advice" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "idx_review_advice_checked_at" ON "review_advice" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "idx_review_advice_consumed_at" ON "review_advice" USING btree ("consumed_at");--> statement-breakpoint
CREATE INDEX "idx_review_advice_identity_lookup" ON "review_advice" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_review_advice_agent_outcome_checked" ON "review_advice" USING btree ("agent_id","outcome","checked_at");