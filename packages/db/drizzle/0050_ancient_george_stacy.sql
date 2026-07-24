ALTER TABLE "llm_decision_artifacts" ALTER COLUMN "decision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_decision_artifacts" ADD COLUMN "decision_ids" jsonb;--> statement-breakpoint
ALTER TABLE "llm_decision_artifacts" ADD COLUMN "source" text DEFAULT 'llm_strategy' NOT NULL;