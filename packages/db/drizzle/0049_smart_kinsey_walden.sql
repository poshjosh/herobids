CREATE TABLE "agent_assessment_review_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual_frontend' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"check_id" text,
	"result_summary" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_assessment_review_runs" ADD CONSTRAINT "agent_assessment_review_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_assessment_review_runs" ADD CONSTRAINT "agent_assessment_review_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_assessment_review_runs" ADD CONSTRAINT "agent_assessment_review_runs_check_id_agent_assessment_review_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."agent_assessment_review_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_review_runs_agent_id" ON "agent_assessment_review_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_review_runs_status" ON "agent_assessment_review_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_review_runs_agent_status" ON "agent_assessment_review_runs" USING btree ("agent_id","status");