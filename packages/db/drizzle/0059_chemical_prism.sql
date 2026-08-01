ALTER TABLE "skill_revisions" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "published_revision_id" text;