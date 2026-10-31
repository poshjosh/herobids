ALTER TABLE "agent_runtime_sessions" ADD COLUMN "runtime_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions" ADD COLUMN "first_placed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions" ADD COLUMN "placement_allocation_id" text;