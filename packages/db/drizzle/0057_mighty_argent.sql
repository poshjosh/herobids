CREATE TABLE "blueprint_fork_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"source_blueprint_id" text NOT NULL,
	"source_blueprint_revision_id" text NOT NULL,
	"fork_blueprint_id" text NOT NULL,
	"response_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprint_instantiation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"blueprint_revision_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"response_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprint_likes" (
	"blueprint_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprint_revision_skills" (
	"blueprint_revision_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_revision_id" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprint_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"blueprint_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"strategy_type" text,
	"style" varchar(16),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"venue_type" text,
	"payload" jsonb NOT NULL,
	"change_summary" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprint_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"blueprint_id" text NOT NULL,
	"blueprint_revision_id" text NOT NULL,
	"user_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"event_type" text NOT NULL,
	"is_self_usage" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blueprints" DROP CONSTRAINT "blueprints_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "bots" DROP CONSTRAINT "bots_blueprint_id_blueprints_id_fk";
--> statement-breakpoint
DROP INDEX "idx_blueprints_user_id";--> statement-breakpoint
DROP INDEX "idx_blueprints_visibility";--> statement-breakpoint
ALTER TABLE "blueprints" ALTER COLUMN "description" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "blueprints" ALTER COLUMN "description" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "blueprint_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "blueprint_revision_id" text;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "author_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "publication_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "delisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "current_revision_id" text;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "published_revision_id" text;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "strategy_type" text;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "style" varchar(16);--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "venue_type" text;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "source_blueprint_id" text;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "source_blueprint_revision_id" text;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "like_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "fork_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "popularity_score" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprints" ADD COLUMN "trending_score" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "blueprint_revision_id" text;--> statement-breakpoint
ALTER TABLE "blueprint_fork_requests" ADD CONSTRAINT "blueprint_fork_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_instantiation_requests" ADD CONSTRAINT "blueprint_instantiation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_likes" ADD CONSTRAINT "blueprint_likes_blueprint_id_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_likes" ADD CONSTRAINT "blueprint_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_revision_skills" ADD CONSTRAINT "blueprint_revision_skills_blueprint_revision_id_blueprint_revisions_id_fk" FOREIGN KEY ("blueprint_revision_id") REFERENCES "public"."blueprint_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_revisions" ADD CONSTRAINT "blueprint_revisions_blueprint_id_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_revisions" ADD CONSTRAINT "blueprint_revisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_usage_events" ADD CONSTRAINT "blueprint_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bpfr_user_key" ON "blueprint_fork_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bpir_user_key" ON "blueprint_instantiation_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_blueprint_likes" ON "blueprint_likes" USING btree ("blueprint_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bprs_revision_skill" ON "blueprint_revision_skills" USING btree ("blueprint_revision_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bprs_revision_order" ON "blueprint_revision_skills" USING btree ("blueprint_revision_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_blueprint_revisions_blueprint_version" ON "blueprint_revisions" USING btree ("blueprint_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_blueprint_revisions_blueprint_id" ON "blueprint_revisions" USING btree ("blueprint_id","id");--> statement-breakpoint
CREATE INDEX "idx_blueprint_revisions_blueprint_created" ON "blueprint_revisions" USING btree ("blueprint_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_blueprint_usage_subject" ON "blueprint_usage_events" USING btree ("subject_kind","subject_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_blueprint_usage_blueprint" ON "blueprint_usage_events" USING btree ("blueprint_id");--> statement-breakpoint
CREATE INDEX "idx_blueprint_usage_user" ON "blueprint_usage_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_blueprint_usage_occurred" ON "blueprint_usage_events" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_source_blueprint_id_blueprints_id_fk" FOREIGN KEY ("source_blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blueprints_author_id" ON "blueprints" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_blueprints_publication_status" ON "blueprints" USING btree ("publication_status");--> statement-breakpoint
CREATE INDEX "idx_blueprints_kind" ON "blueprints" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_blueprints_popularity" ON "blueprints" USING btree ("popularity_score");--> statement-breakpoint
CREATE INDEX "idx_blueprints_trending" ON "blueprints" USING btree ("trending_score");--> statement-breakpoint
CREATE INDEX "idx_blueprints_published_at" ON "blueprints" USING btree ("published_at");--> statement-breakpoint
ALTER TABLE "blueprints" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "blueprints" DROP COLUMN "config_data";--> statement-breakpoint
ALTER TABLE "blueprints" DROP COLUMN "config_version";--> statement-breakpoint
ALTER TABLE "blueprints" DROP COLUMN "visibility";

-- =============================================================================
-- Composite foreign key constraints (not expressible in Drizzle schema DSL)
-- =============================================================================

-- 1. Composite current/published revision pointer FKs on blueprints
ALTER TABLE blueprints ADD CONSTRAINT fk_blueprints_current_revision
  FOREIGN KEY (id, current_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);
ALTER TABLE blueprints ADD CONSTRAINT fk_blueprints_published_revision
  FOREIGN KEY (id, published_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);

-- Prerequisite for the composite FK below: unique constraint on (skill_id, id)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_skill_revisions_skill_id" ON "skill_revisions" ("skill_id", "id");

-- 2. Composite FK on blueprint_revision_skills → skill_revisions
ALTER TABLE blueprint_revision_skills ADD CONSTRAINT fk_bprs_skill_revision
  FOREIGN KEY (skill_id, skill_revision_id) REFERENCES skill_revisions(skill_id, id);

-- 3. Composite FK on source blueprint lineage
ALTER TABLE blueprints ADD CONSTRAINT fk_blueprints_source_revision
  FOREIGN KEY (source_blueprint_id, source_blueprint_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);

-- 4. Paired-null checks on agents and bots (both null or both non-null)
ALTER TABLE agents ADD CONSTRAINT chk_agents_blueprint_attribution_paired
  CHECK ((blueprint_id IS NULL AND blueprint_revision_id IS NULL) OR (blueprint_id IS NOT NULL AND blueprint_revision_id IS NOT NULL));
ALTER TABLE bots ADD CONSTRAINT chk_bots_blueprint_attribution_paired
  CHECK ((blueprint_id IS NULL AND blueprint_revision_id IS NULL) OR (blueprint_id IS NOT NULL AND blueprint_revision_id IS NOT NULL));

-- 5. Composite attribution FKs on agents and bots
ALTER TABLE agents ADD CONSTRAINT fk_agents_blueprint_revision
  FOREIGN KEY (blueprint_id, blueprint_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);
ALTER TABLE bots ADD CONSTRAINT fk_bots_blueprint_revision
  FOREIGN KEY (blueprint_id, blueprint_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);

-- 6. Composite FK on usage events
ALTER TABLE blueprint_usage_events ADD CONSTRAINT fk_bpue_revision
  FOREIGN KEY (blueprint_id, blueprint_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);

-- 7. Composite FKs on instantiation/fork requests
ALTER TABLE blueprint_instantiation_requests ADD CONSTRAINT fk_bpir_revision
  FOREIGN KEY (blueprint_id, blueprint_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);
ALTER TABLE blueprint_fork_requests ADD CONSTRAINT fk_bpfr_source_revision
  FOREIGN KEY (source_blueprint_id, source_blueprint_revision_id) REFERENCES blueprint_revisions(blueprint_id, id);

-- =============================================================================
-- Lifecycle state integrity checks on blueprints
-- =============================================================================

-- 8a. draft/private: no published pointer or publication timestamps
ALTER TABLE blueprints ADD CONSTRAINT chk_blueprints_lifecycle_draft_private
  CHECK (
    (publication_status IN ('draft', 'private') AND published_revision_id IS NULL AND published_at IS NULL AND delisted_at IS NULL AND archived_at IS NULL)
    OR publication_status NOT IN ('draft', 'private')
  );

-- 8b. published: requires publishedRevisionId and publishedAt, no delist/archive timestamp
ALTER TABLE blueprints ADD CONSTRAINT chk_blueprints_lifecycle_published
  CHECK (
    (publication_status = 'published' AND published_revision_id IS NOT NULL AND published_at IS NOT NULL AND delisted_at IS NULL AND archived_at IS NULL)
    OR publication_status != 'published'
  );

-- 8c. delisted: retains published pointer, publishedAt, and delistedAt
ALTER TABLE blueprints ADD CONSTRAINT chk_blueprints_lifecycle_delisted
  CHECK (
    (publication_status = 'delisted' AND published_revision_id IS NOT NULL AND published_at IS NOT NULL AND delisted_at IS NOT NULL AND archived_at IS NULL)
    OR publication_status != 'delisted'
  );

-- 8d. archived: requires archivedAt
ALTER TABLE blueprints ADD CONSTRAINT chk_blueprints_lifecycle_archived
  CHECK (
    (publication_status = 'archived' AND archived_at IS NOT NULL)
    OR publication_status != 'archived'
  );

-- 9. Paired-null check on source blueprint lineage
ALTER TABLE blueprints ADD CONSTRAINT chk_blueprints_source_lineage_paired
  CHECK ((source_blueprint_id IS NULL AND source_blueprint_revision_id IS NULL)
      OR (source_blueprint_id IS NOT NULL AND source_blueprint_revision_id IS NOT NULL));