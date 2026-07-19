CREATE TABLE "agent_assessment_review_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"effective_interval_ms" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	"next_eligible_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_holder_id" text,
	"lease_acquired_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"policy_version" text,
	"outcome_summary" jsonb,
	"check_outcome" text,
	"error_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_preset_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"scope" text NOT NULL,
	"active_preset_key" text NOT NULL,
	"style_tier" text NOT NULL,
	"behavior_version" text DEFAULT 'v1' NOT NULL,
	"applied_preset_version" text DEFAULT 'v1' NOT NULL,
	"source_artifact_id" text,
	"source_transition_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_scan_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"scan_version" text NOT NULL,
	"active_preset_key" text NOT NULL,
	"preset_behavior_version" text NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"raw_candidate_id" text,
	"resolution_status" text,
	"candidate_rank" integer NOT NULL,
	"scan_scope" text,
	"signal_facts" jsonb,
	"confidence" numeric,
	"regime_bucket" text,
	"volatility_fact" numeric,
	"data_freshness_ts" timestamp with time zone,
	"disposition" text DEFAULT 'discovered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_advice" ADD COLUMN "check_id" text;--> statement-breakpoint
ALTER TABLE "agent_assessment_review_checks" ADD CONSTRAINT "agent_assessment_review_checks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preset_bindings" ADD CONSTRAINT "agent_preset_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preset_bindings" ADD CONSTRAINT "agent_preset_bindings_source_artifact_id_market_assessment_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."market_assessment_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preset_bindings" ADD CONSTRAINT "agent_preset_bindings_source_transition_id_agent_preset_transitions_id_fk" FOREIGN KEY ("source_transition_id") REFERENCES "public"."agent_preset_transitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scan_candidates" ADD CONSTRAINT "agent_scan_candidates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_review_checks_agent_id" ON "agent_assessment_review_checks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_review_checks_status" ON "agent_assessment_review_checks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_review_checks_due_at" ON "agent_assessment_review_checks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "idx_review_checks_agent_status" ON "agent_assessment_review_checks" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_review_checks_lease_expires" ON "agent_assessment_review_checks" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_agent_preset_bindings_agent_id" ON "agent_preset_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_preset_bindings_status" ON "agent_preset_bindings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_preset_bindings_agent_scope" ON "agent_preset_bindings" USING btree ("agent_id","scope");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_agent_scanned" ON "agent_scan_candidates" USING btree ("agent_id","scanned_at");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_identity" ON "agent_scan_candidates" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_rank" ON "agent_scan_candidates" USING btree ("agent_id","candidate_rank");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_disposition" ON "agent_scan_candidates" USING btree ("disposition");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_resolution" ON "agent_scan_candidates" USING btree ("resolution_status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_scan_candidates_agent_scan_rank" ON "agent_scan_candidates" USING btree ("agent_id","scanned_at","raw_candidate_id");--> statement-breakpoint
ALTER TABLE "review_advice" ADD CONSTRAINT "review_advice_check_id_agent_assessment_review_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."agent_assessment_review_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_review_advice_check_id" ON "review_advice" USING btree ("check_id");