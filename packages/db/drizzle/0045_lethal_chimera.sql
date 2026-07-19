ALTER TABLE "market_assessment_runs" ADD COLUMN "evidence_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "market_assessment_runs" ADD COLUMN "scorecard_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "market_assessment_runs" ADD COLUMN "calculation_versions" jsonb DEFAULT '{}'::jsonb NOT NULL;