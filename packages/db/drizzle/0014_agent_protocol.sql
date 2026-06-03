-- Migration 0014: agent protocol tables + decision actor attribution columns
-- Adds: agents, agent_instance_links, agent_runtime_sessions, agent_messages, agent_artifacts
-- Alters: decisions (actor_type, actor_id)

CREATE TABLE "agents" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "name" text NOT NULL,
  "goal" text NOT NULL,
  "status" text NOT NULL DEFAULT 'stopped',
  "pause_state" jsonb,
  "tool_policy" jsonb,
  "model_policy" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_agents_user_id" ON "agents" ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_agents_status" ON "agents" ("status");
--> statement-breakpoint

CREATE TABLE "agent_instance_links" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL REFERENCES "agents"("id"),
  "trading_instance_id" text NOT NULL REFERENCES "trading_instances"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_agent_instance_links_agent_id" ON "agent_instance_links" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_instance_links_trading_instance_id" ON "agent_instance_links" ("trading_instance_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_instance_links_active_agent" ON "agent_instance_links" ("agent_id") WHERE "status" = 'active';
--> statement-breakpoint

CREATE TABLE "agent_runtime_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL REFERENCES "agents"("id"),
  "trading_instance_id" text NOT NULL REFERENCES "trading_instances"("id"),
  "status" text NOT NULL DEFAULT 'starting',
  "last_heartbeat_at" timestamp with time zone,
  "cpu_pct" integer,
  "memory_bytes" integer,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_agent_id" ON "agent_runtime_sessions" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_trading_instance_id" ON "agent_runtime_sessions" ("trading_instance_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_runtime_sessions_status" ON "agent_runtime_sessions" ("status");
--> statement-breakpoint

CREATE TABLE "agent_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "message_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "trading_instance_id" text NOT NULL,
  "type" text NOT NULL,
  "direction" text NOT NULL,
  "schema_version" text NOT NULL DEFAULT 'v1',
  "sequence" integer,
  "trace_id" text,
  "processing_status" text NOT NULL DEFAULT 'received',
  "error_detail" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_correlation_id" ON "agent_messages" ("correlation_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_trading_instance_id" ON "agent_messages" ("trading_instance_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_type" ON "agent_messages" ("type");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_actor_id" ON "agent_messages" ("actor_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_created_at" ON "agent_messages" ("created_at");
--> statement-breakpoint

CREATE TABLE "agent_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL REFERENCES "agents"("id"),
  "session_id" text NOT NULL,
  "artifact_type" text NOT NULL,
  "content_type" text NOT NULL,
  "summary" text NOT NULL,
  "location" jsonb,
  "metadata" jsonb,
  "retention_class" text NOT NULL DEFAULT 'standard',
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_agent_id" ON "agent_artifacts" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_session_id" ON "agent_artifacts" ("session_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_artifact_type" ON "agent_artifacts" ("artifact_type");
--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_created_at" ON "agent_artifacts" ("created_at");
--> statement-breakpoint

ALTER TABLE "decisions" ADD COLUMN "actor_type" text NOT NULL DEFAULT 'system';
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "actor_id" text;
--> statement-breakpoint
CREATE INDEX "idx_decisions_actor_type" ON "decisions" ("actor_type");
