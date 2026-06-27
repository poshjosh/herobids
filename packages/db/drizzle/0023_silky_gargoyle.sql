ALTER TABLE "agents" ADD COLUMN "runtime_policy_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "daily_token_budget";