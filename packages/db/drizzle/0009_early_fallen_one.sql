CREATE TABLE "agent_skills" (
	"agent_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_revision_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by_user_id" text,
	"assignment_source" text DEFAULT 'user_select' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_entitlements" (
	"skill_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text DEFAULT 'owner' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill_likes" (
	"skill_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"required_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"context_requirements" text[] DEFAULT '{}'::text[] NOT NULL,
	"required_guardrails" text[] DEFAULT '{}'::text[] NOT NULL,
	"capability_families" text[] DEFAULT '{}'::text[] NOT NULL,
	"suggested_tick_interval_ms" integer,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"change_summary" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"skill_revision_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"session_id" text,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "publication_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "delisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "current_revision_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "price_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "auto_published_by_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "like_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "fork_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "popularity_score" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "trending_score" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO "skill_revisions" (
	"id",
	"skill_id",
	"version",
	"name",
	"description",
	"instructions",
	"required_tools",
	"context_requirements",
	"required_guardrails",
	"capability_families",
	"suggested_tick_interval_ms",
	"tags",
	"change_summary",
	"created_by_user_id",
	"created_at"
)
SELECT
	("skills"."id" || ':v1') AS "id",
	"skills"."id" AS "skill_id",
	1 AS "version",
	"skills"."name",
	"skills"."description",
	"skills"."instructions",
	"skills"."required_tools",
	"skills"."context_requirements",
	"skills"."required_guardrails",
	"skills"."capability_families",
	"skills"."suggested_tick_interval_ms",
	COALESCE("skills"."tags", '{}'::text[]) AS "tags",
	'migration_backfill' AS "change_summary",
	"skills"."author_id" AS "created_by_user_id",
	COALESCE("skills"."created_at", now()) AS "created_at"
FROM "skills"
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "skills"
SET
	"publication_status" = CASE
		WHEN "author_id" IS NULL THEN 'published'
		WHEN "visibility" = 'public' THEN 'published'
		ELSE 'draft'
	END,
	"published_at" = CASE
		WHEN "author_id" IS NULL THEN COALESCE("published_at", "created_at", now())
		WHEN "visibility" = 'public' THEN COALESCE("published_at", "created_at", now())
		ELSE NULL
	END,
	"current_revision_id" = COALESCE("current_revision_id", "id" || ':v1'),
	"visibility" = CASE
		WHEN "author_id" IS NULL THEN 'built-in'
		WHEN "visibility" = 'public' THEN 'public'
		ELSE 'private'
	END,
	"updated_at" = COALESCE("updated_at", now());--> statement-breakpoint
INSERT INTO "agent_skills" (
	"agent_id",
	"skill_id",
	"skill_revision_id",
	"assigned_at",
	"assigned_by_user_id",
	"assignment_source"
)
SELECT
	"agents"."id" AS "agent_id",
	"sid"."skill_id" AS "skill_id",
	"skills"."current_revision_id" AS "skill_revision_id",
	COALESCE("agents"."updated_at", "agents"."created_at", now()) AS "assigned_at",
	"agents"."user_id" AS "assigned_by_user_id",
	'migration_backfill' AS "assignment_source"
FROM "agents"
CROSS JOIN LATERAL unnest("agents"."skill_ids") AS "sid"("skill_id")
INNER JOIN "skills" ON "skills"."id" = "sid"."skill_id"
WHERE "skills"."current_revision_id" IS NOT NULL
ON CONFLICT ("agent_id", "skill_id") DO UPDATE
SET
	"skill_revision_id" = EXCLUDED."skill_revision_id",
	"assigned_at" = EXCLUDED."assigned_at",
	"assigned_by_user_id" = EXCLUDED."assigned_by_user_id",
	"assignment_source" = EXCLUDED."assignment_source";--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_revision_id_skill_revisions_id_fk" FOREIGN KEY ("skill_revision_id") REFERENCES "public"."skill_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_entitlements" ADD CONSTRAINT "skill_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_likes" ADD CONSTRAINT "skill_likes_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_likes" ADD CONSTRAINT "skill_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_revision_id_skill_revisions_id_fk" FOREIGN KEY ("skill_revision_id") REFERENCES "public"."skill_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_session_id_agent_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_runtime_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_skills_agent_skill" ON "agent_skills" USING btree ("agent_id","skill_id");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_skill_revision_id" ON "agent_skills" USING btree ("skill_revision_id");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_agent_id" ON "agent_skills" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skill_entitlements_skill_user" ON "skill_entitlements" USING btree ("skill_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_skill_entitlements_user_granted" ON "skill_entitlements" USING btree ("user_id","granted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skill_likes_skill_user" ON "skill_likes" USING btree ("skill_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_skill_likes_user_created" ON "skill_likes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skill_revisions_skill_version" ON "skill_revisions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "idx_skill_revisions_skill_created" ON "skill_revisions" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_skill_usage_events_skill_occurred" ON "skill_usage_events" USING btree ("skill_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_skill_usage_events_type_occurred" ON "skill_usage_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_skill_usage_events_user_occurred" ON "skill_usage_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_skills_publication_status" ON "skills" USING btree ("publication_status");--> statement-breakpoint
CREATE INDEX "idx_skills_popularity_score" ON "skills" USING btree ("popularity_score");--> statement-breakpoint
CREATE INDEX "idx_skills_trending_score" ON "skills" USING btree ("trending_score");