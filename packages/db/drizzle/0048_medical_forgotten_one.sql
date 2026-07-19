ALTER TABLE "agent_preset_transitions" ADD COLUMN "state" text DEFAULT 'prepared' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_preset_transitions" ADD COLUMN "position_action_results" jsonb;--> statement-breakpoint
ALTER TABLE "agent_preset_transitions" ADD COLUMN "transition_scope" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agent_preset_transitions_state" ON "agent_preset_transitions" USING btree ("state");