ALTER TABLE "skill_revisions" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_installed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skills_source_ref" ON "skills" USING btree ("source_ref") WHERE "skills"."source_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "capital";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "risk_overrides";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "risk";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "execution_defaults";
