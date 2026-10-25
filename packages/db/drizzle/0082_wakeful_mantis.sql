CREATE TABLE "agent_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_audit_events" ADD CONSTRAINT "agent_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_audit_events_user_created" ON "agent_audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_audit_events_target" ON "agent_audit_events" USING btree ("target_id");