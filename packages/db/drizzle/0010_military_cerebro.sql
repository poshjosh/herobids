DROP INDEX "idx_skills_visibility";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "skill_ids";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "visibility";