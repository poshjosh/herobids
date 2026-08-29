-- Add slug column for unified skill addressing (system/trading, alice/my-skill).
ALTER TABLE "skills" ADD COLUMN "slug" text;
--> statement-breakpoint
-- Backfill system skills: author_id IS NULL → 'system/<kebab-name>'
UPDATE "skills" SET "slug" = 'system/' || LOWER(REPLACE("name", ' ', '-')) WHERE "author_id" IS NULL;
--> statement-breakpoint
-- Backfill user-authored skills: '<username>/<kebab-name>'
UPDATE "skills" SET "slug" = u."username" || '/' || LOWER(REPLACE("skills"."name", ' ', '-')) FROM "users" u WHERE "skills"."author_id" = u."id";
--> statement-breakpoint
-- Partial unique index (allows NULLs during transition, enforces uniqueness on populated rows)
CREATE UNIQUE INDEX "idx_skills_slug" ON "skills" USING btree ("slug") WHERE "slug" IS NOT NULL;
--> statement-breakpoint
-- Make NOT NULL after confirming all rows are populated
ALTER TABLE "skills" ALTER COLUMN "slug" SET NOT NULL;
