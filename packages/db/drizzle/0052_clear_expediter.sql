DROP INDEX "idx_llm_decision_artifacts_decision_ids";--> statement-breakpoint
ALTER TABLE "review_advice" ADD COLUMN "assessment_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_review_advice_assessment_requested_at" ON "review_advice" USING btree ("assessment_requested_at");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_decision_ids" ON "llm_decision_artifacts" USING btree ("decision_ids");