-- Migration 0008: user_plans table and foreign key constraints from all owner tables to users.

-- Create the user_plans table (canonical plan assignment per user).
CREATE TABLE "user_plans" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "plan_id" text DEFAULT 'free' NOT NULL,
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_user_plans_user_id" ON "user_plans" ("user_id");

-- Backfill: create placeholder users for any existing user_id values that
-- don't yet have a users row. This ensures the FK constraints below succeed
-- on non-empty databases (dev, staging). In production, real user rows are
-- created by the OAuth flow before any owned resources exist.
INSERT INTO "users" ("id", "display_name", "email", "plan_id", "created_at", "updated_at")
SELECT DISTINCT sub.uid, 'Legacy User', sub.uid || '@placeholder.local', 'free', now(), now()
FROM (
  SELECT "user_id" AS uid FROM "credentials"
  UNION SELECT "user_id" FROM "portfolios"
  UNION SELECT "user_id" FROM "trading_instances"
  UNION SELECT "user_id" FROM "venue_accounts"
  UNION SELECT "user_id" FROM "oauth_identities"
  UNION SELECT "user_id" FROM "sessions"
  UNION SELECT "user_id" FROM "backtest_runs"
  UNION SELECT "user_id" FROM "replay_corpora"
) sub
WHERE sub.uid IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = sub.uid);

-- Add FK constraints on all tables whose user_id columns previously had no FK.
-- These enforce referential integrity from owner columns to users.id.

ALTER TABLE "credentials"
  ADD CONSTRAINT "credentials_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "portfolios"
  ADD CONSTRAINT "portfolios_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "trading_instances"
  ADD CONSTRAINT "trading_instances_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "venue_accounts"
  ADD CONSTRAINT "venue_accounts_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "oauth_identities"
  ADD CONSTRAINT "oauth_identities_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "backtest_runs"
  ADD CONSTRAINT "backtest_runs_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "replay_corpora"
  ADD CONSTRAINT "replay_corpora_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");

-- Seed user_plans rows for every existing user so the canonical history table
-- is non-empty from the moment this migration runs. New users are seeded at
-- first-login time by the OAuth flow.
INSERT INTO "user_plans" ("id", "user_id", "plan_id")
SELECT gen_random_uuid()::text, "id", "plan_id"
FROM "users"
WHERE NOT EXISTS (
  SELECT 1 FROM "user_plans" WHERE "user_plans"."user_id" = "users"."id"
);
