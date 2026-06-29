CREATE TABLE "agent_connection_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_connection_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provider_type" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "resolved_venue_account_id" text;--> statement-breakpoint
ALTER TABLE "agent_connection_audit" ADD CONSTRAINT "agent_connection_audit_agent_connection_id_agent_connections_id_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_connection_audit_ac_id" ON "agent_connection_audit" USING btree ("agent_connection_id");--> statement-breakpoint
CREATE INDEX "idx_agent_connection_audit_created_at" ON "agent_connection_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_connections_agent_id" ON "agent_connections" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_connections_connection_id" ON "agent_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_agent_connections_status" ON "agent_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_connections_active" ON "agent_connections" USING btree ("agent_id","connection_id") WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_resolved_venue_account_id_venue_accounts_id_fk" FOREIGN KEY ("resolved_venue_account_id") REFERENCES "public"."venue_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Seed provider records
INSERT INTO "providers" ("id", "name", "capabilities", "status", "provider_type") VALUES
  ('hyperliquid', 'Hyperliquid', '["trading"]', 'active', 'dex_perp'),
  ('jupiter', 'Jupiter', '["trading"]', 'active', 'dex_spot'),
  ('1inch', '1inch', '["trading"]', 'active', 'dex_spot'),
  ('bybit', 'Bybit', '["trading"]', 'active', 'cex');--> statement-breakpoint

-- Backfill agent_connections from capability_grants
-- One row per (agent_id, connection_id) from active grants.
-- Capability families are no longer stored at the grant level — they
-- are derived from providers.capabilities through the connection's provider.
INSERT INTO "agent_connections" ("id", "agent_id", "connection_id", "status", "granted_by", "granted_at", "revoked_at", "meta", "created_at", "updated_at")
SELECT DISTINCT ON ("agent_id", "connection_id")
  gen_random_uuid()::text,
  "agent_id",
  "connection_id",
  "status",
  "granted_by",
  "granted_at",
  "revoked_at",
  "meta",
  "created_at",
  "updated_at"
FROM "capability_grants"
WHERE "status" = 'active'
ORDER BY "agent_id", "connection_id", "created_at" DESC;--> statement-breakpoint

-- Backfill agent_connection_audit from capability_grant_audit
INSERT INTO "agent_connection_audit" ("id", "agent_connection_id", "action", "actor_type", "actor_id", "reason", "detail", "created_at")
SELECT
  gen_random_uuid()::text,
  ac."id",
  cga."action",
  cga."actor_type",
  cga."actor_id",
  cga."reason",
  cga."detail",
  cga."created_at"
FROM "capability_grant_audit" cga
JOIN "capability_grants" cg ON cg."id" = cga."grant_id"
JOIN "agent_connections" ac ON ac."agent_id" = cg."agent_id" AND ac."connection_id" = cg."connection_id";--> statement-breakpoint

-- Backfill connections.resolvedVenueAccountId
-- Match connections to venue_accounts where provider = venue and same user, pick earliest match
UPDATE "connections" c SET "resolved_venue_account_id" = (
  SELECT va."id" FROM "venue_accounts" va
  WHERE va."venue" = c."provider"
    AND va."user_id" = c."user_id"
  ORDER BY va."created_at" ASC
  LIMIT 1
)
WHERE c."resolved_venue_account_id" IS NULL;--> statement-breakpoint

-- Providers indexes
CREATE INDEX "idx_providers_status" ON "providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_providers_provider_type" ON "providers" USING btree ("provider_type");--> statement-breakpoint

-- Drop old capability grant tables (replaced by agent_connections + agent_connection_audit)
-- DEFERRED to later phase: runtime code in agent-runtime-descriptor.ts still queries capability_grants.
-- These tables will be dropped in Phase 5 or 8 once all runtime code is updated.
-- DROP TABLE "capability_grant_audit" CASCADE;
-- DROP TABLE "capability_grants" CASCADE;