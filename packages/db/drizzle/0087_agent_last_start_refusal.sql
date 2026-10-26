ALTER TABLE "agents" ADD COLUMN "last_start_refusal" jsonb;--> statement-breakpoint
CREATE INDEX "idx_agents_parent_name_created" ON "agents" USING btree ("parent_agent_id","name","created_at");