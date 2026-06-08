-- 023: Add capability_families column to skills and update system skills
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "capability_families" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
UPDATE "skills" SET "capability_families" = ARRAY['trading'] WHERE "id" IN ('bot-management', 'risk-monitoring');
