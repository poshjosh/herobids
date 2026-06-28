CREATE TABLE "agent_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"requested_scope_json" jsonb NOT NULL,
	"resolved_scope_json" jsonb NOT NULL,
	"scope_key" text NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"timed_out_at" timestamp with time zone,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"error_message" text,
	"scorecard_json" jsonb,
	"summary_json" jsonb,
	"artifact_manifest_json" jsonb
);
--> statement-breakpoint
ALTER TABLE "agent_evaluations" ADD CONSTRAINT "agent_evaluations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_evaluations_agent_id" ON "agent_evaluations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_evaluations_status" ON "agent_evaluations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agent_evaluations_scope_key" ON "agent_evaluations" USING btree ("agent_id","scope_key");--> statement-breakpoint
CREATE INDEX "idx_agent_evaluations_requested_at" ON "agent_evaluations" USING btree ("requested_at");