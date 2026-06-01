-- Alert deliveries table for tracking notification dispatch.
CREATE TABLE "alert_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "journal_event_id" text NOT NULL,
  "channel" text NOT NULL,
  "destination" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_alert_deliveries_status" ON "alert_deliveries" ("status");
CREATE INDEX "idx_alert_deliveries_journal_event_id" ON "alert_deliveries" ("journal_event_id");

-- Users table.
CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "avatar_url" text,
  "plan_id" text DEFAULT 'free' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- OAuth identities table.
CREATE TABLE "oauth_identities" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "provider_user_id" text NOT NULL,
  "email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_oauth_identities_user_id" ON "oauth_identities" ("user_id");
CREATE INDEX "idx_oauth_identities_provider_user_id" ON "oauth_identities" ("provider", "provider_user_id");

-- Sessions table.
CREATE TABLE "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_sessions_user_id" ON "sessions" ("user_id");
CREATE INDEX "idx_sessions_expires_at" ON "sessions" ("expires_at");

-- Add user_id to backtest_runs (nullable for legacy backfill; wipe strategy makes this moot).
ALTER TABLE "backtest_runs" ADD COLUMN "user_id" text;

-- Add user_id to replay_corpora.
ALTER TABLE "replay_corpora" ADD COLUMN "user_id" text;
