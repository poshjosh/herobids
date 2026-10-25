ALTER TABLE "agents" ADD COLUMN "creator_type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "creator_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "parent_agent_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "child_agent_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "agents" SET "creator_id" = "user_id" WHERE "creator_type" = 'user' AND "creator_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agents_parent_agent_id" ON "agents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE INDEX "idx_agents_user_creator_type" ON "agents" USING btree ("user_id","creator_type");